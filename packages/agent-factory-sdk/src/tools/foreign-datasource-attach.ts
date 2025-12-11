import type { Datasource } from '@qwery/domain/entities';
import type { SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';
import { getProviderMapping, getSupportedProviders } from './provider-registry';
import { getDatasourceDatabaseName } from './datasource-name-utils';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

export interface ForeignDatasourceAttachOptions {
  connection: Connection; // Changed from dbPath
  datasource: Datasource;
}

export interface AttachResult {
  attachedDatabaseName: string;
  tables: Array<{
    schema: string;
    table: string;
    path: string;
    schemaDefinition?: SimpleSchema;
  }>;
}

export interface AttachToConnectionOptions {
  conn: Awaited<
    ReturnType<
      Awaited<
        ReturnType<typeof import('@duckdb/node-api').DuckDBInstance.create>
      >['connect']
    >
  >;
  datasource: Datasource;
}

/**
 * Attach a foreign datasource to an existing DuckDB connection
 * This is used when you already have a connection and need to attach datasources
 * (since DuckDB attachments are session-scoped)
 */
export async function attachForeignDatasourceToConnection(
  opts: AttachToConnectionOptions,
): Promise<void> {
  const { conn, datasource } = opts;
  const provider = datasource.datasource_provider;
  const config = datasource.config as Record<string, unknown>;

  // Get provider mapping using abstraction
  const mapping = await getProviderMapping(provider);
  if (!mapping) {
    const supported = await getSupportedProviders();
    throw new Error(
      `Foreign database type not supported: ${provider}. Supported types: ${supported.join(', ')}`,
    );
  }

  // Use datasource name directly as database name (sanitized)
  const attachedDatabaseName = getDatasourceDatabaseName(datasource);

  // Install and load the appropriate extension if needed
  if (mapping.requiresExtension && mapping.extensionName) {
    await conn.run(`INSTALL ${mapping.extensionName}`);
    await conn.run(`LOAD ${mapping.extensionName}`);
  }

  // Get connection string using abstraction
  let connectionString: string;
  try {
    connectionString = mapping.getConnectionString(config);
  } catch (error) {
    // Skip this datasource if connection string is missing (matches main branch behavior)
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (errorMsg.includes('requires')) {
      return;
    }
    throw error;
  }

  // Build attach query based on DuckDB type
  let attachQuery: string;
  if (mapping.duckdbType === 'SQLITE') {
    attachQuery = `ATTACH '${connectionString.replace(/'/g, "''")}' AS "${attachedDatabaseName}"`;
  } else {
    attachQuery = `ATTACH '${connectionString.replace(/'/g, "''")}' AS "${attachedDatabaseName}" (TYPE ${mapping.duckdbType})`;
  }

  // Attach the foreign database
  try {
    await conn.run(attachQuery);
    console.log(
      `[ReadDataAgent] Attached ${attachedDatabaseName} (${mapping.duckdbType})`,
    );
  } catch (error) {
    // If already attached, that's okay
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      !errorMsg.includes('already attached') &&
      !errorMsg.includes('already exists')
    ) {
      throw error;
    }
  }
}

/**
 * Attach all foreign datasources for a conversation to an existing connection
 * This ensures foreign datasources are available for queries (since attachments are session-scoped)
 */
export async function attachAllForeignDatasourcesToConnection(opts: {
  conn: Awaited<
    ReturnType<
      Awaited<
        ReturnType<typeof import('@duckdb/node-api').DuckDBInstance.create>
      >['connect']
    >
  >;
  datasourceIds: string[];
  datasourceRepository: import('@qwery/domain/repositories').IDatasourceRepository;
}): Promise<void> {
  const { conn, datasourceIds, datasourceRepository } = opts;

  if (!datasourceIds || datasourceIds.length === 0) {
    return;
  }

  const { loadDatasources, groupDatasourcesByType } = await import(
    './datasource-loader'
  );

  try {
    const loaded = await loadDatasources(datasourceIds, datasourceRepository);
    const { foreignDatabases } = groupDatasourcesByType(loaded);

    for (const { datasource } of foreignDatabases) {
      try {
        await attachForeignDatasourceToConnection({ conn, datasource });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Only warn if it's not a "skip" case (missing config returns early, not an error)
        // Log but don't fail - other datasources might still work
        if (
          !errorMsg.includes('already attached') &&
          !errorMsg.includes('already exists')
        ) {
          console.warn(
            `[ReadDataAgent] Failed to attach datasource ${datasource.id}: ${errorMsg}`,
          );
        }
      }
    }
  } catch (error) {
    // Log but don't fail - query might still work with other datasources
    console.warn(
      '[ForeignDatasourceAttach] Failed to load datasources for attachment:',
      error,
    );
  }
}

/**
 * Attach a foreign database to DuckDB and create views
 * Supports PostgreSQL, MySQL, SQLite, etc. via DuckDB foreign data wrappers
 */
export async function attachForeignDatasource(
  opts: ForeignDatasourceAttachOptions,
): Promise<AttachResult> {
  const { connection: conn, datasource } = opts;

  const provider = datasource.datasource_provider;
  const config = datasource.config as Record<string, unknown>;
  const tablesInfo: AttachResult['tables'] = [];

  // Get provider mapping using abstraction
  const mapping = await getProviderMapping(provider);
  if (!mapping) {
    const supported = await getSupportedProviders();
    throw new Error(
      `Foreign database type not supported: ${provider}. Supported types: ${supported.join(', ')}`,
    );
  }

  // Use datasource name directly as database name (sanitized)
  const attachedDatabaseName = getDatasourceDatabaseName(datasource);

  // Install and load the appropriate extension if needed
  if (mapping.requiresExtension && mapping.extensionName) {
    await conn.run(`INSTALL ${mapping.extensionName}`);
    await conn.run(`LOAD ${mapping.extensionName}`);
  }

  // Get connection string using abstraction
  const connectionString = mapping.getConnectionString(config);

  // Build attach query based on DuckDB type
  let attachQuery: string;
  if (mapping.duckdbType === 'SQLITE') {
    attachQuery = `ATTACH '${connectionString.replace(/'/g, "''")}' AS "${attachedDatabaseName}"`;
  } else {
    attachQuery = `ATTACH '${connectionString.replace(/'/g, "''")}' AS "${attachedDatabaseName}" (TYPE ${mapping.duckdbType})`;
  }

  // Attach the foreign database
  try {
    await conn.run(attachQuery);
    console.debug(
      `[ForeignDatasourceAttach] Attached ${attachedDatabaseName} (${mapping.duckdbType})`,
    );
  } catch (error) {
    // If already attached, that's okay
    const errorMsg = error instanceof Error ? error.message : String(error);
    if (
      !errorMsg.includes('already attached') &&
      !errorMsg.includes('already exists')
    ) {
      throw error;
    }
  }

  // Get list of tables from the attached database using abstraction
  const tablesQuery = mapping.getTablesQuery(attachedDatabaseName);

  const tablesReader = await conn.runAndReadAll(tablesQuery);
  await tablesReader.readAll();
  const tables = tablesReader.getRowObjectsJS() as Array<{
    table_schema: string;
    table_name: string;
  }>;

  // Get system schemas using extension abstraction (once, outside loop)
  const { getSystemSchemas, isSystemTableName } = await import(
    './system-schema-filter'
  );
  const systemSchemas = await getSystemSchemas(datasource.datasource_provider);

  // Create views for each table
  for (const table of tables) {
    const schemaName = table.table_schema || 'main';
    const tableName = table.table_name;

    // Skip system/internal schemas and tables
    if (systemSchemas.has(schemaName.toLowerCase())) {
      continue;
    }

    // Skip system tables
    if (isSystemTableName(tableName)) {
      continue;
    }

    try {
      // Generate semantic view name
      // Use attached database path directly (no view creation)
      const escapedSchemaName = schemaName.replace(/"/g, '""');
      const escapedTableName = tableName.replace(/"/g, '""');
      const escapedDbName = attachedDatabaseName.replace(/"/g, '""');
      const tablePath = `${attachedDatabaseName}.${schemaName}.${tableName}`;

      // Test if we can access the table directly
      try {
        await conn.run(
          `SELECT 1 FROM "${escapedDbName}"."${escapedSchemaName}"."${escapedTableName}" LIMIT 1`,
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        // Check if it's a permission or access error
        const isPermissionError =
          errorMsg.includes('permission') ||
          errorMsg.includes('access') ||
          errorMsg.includes('denied') ||
          errorMsg.includes('does not exist') ||
          errorMsg.includes('relation');

        if (isPermissionError) {
          // REMOVE: console.debug - just skip silently
          // Permission errors are expected for system tables or restricted schemas
        } else {
          // Only log unexpected errors
          console.warn(
            `[ForeignDatasourceAttach] Cannot access table ${schemaName}.${tableName}: ${errorMsg}`,
          );
        }
        // Skip this table and continue with others
        continue;
      }

      // Extract schema directly from the attached table (for optional diagnostics)
      let schema: SimpleSchema | undefined;
      try {
        const describeQuery = `DESCRIBE "${escapedDbName}"."${escapedSchemaName}"."${escapedTableName}"`;
        const describeReader = await conn.runAndReadAll(describeQuery);
        await describeReader.readAll();
        const describeRows = describeReader.getRowObjectsJS() as Array<{
          column_name: string;
          column_type: string;
          null: string;
        }>;

        schema = {
          databaseName: schemaName,
          schemaName,
          tables: [
            {
              tableName,
              columns: describeRows.map((col) => ({
                columnName: col.column_name,
                columnType: col.column_type,
              })),
            },
          ],
        };
      } catch {
        // Non-blocking; we still expose the path
        schema = undefined;
      }

      tablesInfo.push({
        schema: schemaName,
        table: tableName,
        path: tablePath,
        schemaDefinition: schema,
      });
    } catch (error) {
      // Log error but continue with other tables
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[ForeignDatasourceAttach] Error processing table ${schemaName}.${tableName}: ${errorMsg}`,
      );
      // Continue with next table
    }
  }

  return {
    attachedDatabaseName,
    tables: tablesInfo,
  };
}
