import type { Datasource } from '@qwery/domain/entities';
import type { SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';

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
  const provider = datasource.datasource_provider.toLowerCase();
  const config = datasource.config as Record<string, unknown>;

  // Generate a unique database name for this datasource attachment
  const attachedDatabaseName = `ds_${datasource.id.replace(/-/g, '_')}`;

  // Install and load the appropriate extension
  let attachQuery: string;
  let connectionUrlForLog: string | undefined;

  switch (provider) {
    case 'postgresql':
    case 'neon':
    case 'supabase': {
      await conn.run('INSTALL postgres');
      await conn.run('LOAD postgres');

      const connectionUrl = config.connectionUrl as string;
      if (!connectionUrl) {
        return;
      }

      connectionUrlForLog = connectionUrl;
      attachQuery = `ATTACH '${connectionUrl.replace(/'/g, "''")}' AS "${attachedDatabaseName}" (TYPE POSTGRES)`;
      break;
    }

    case 'mysql': {
      await conn.run('INSTALL mysql');
      await conn.run('LOAD mysql');

      const connectionUrl =
        (config.connectionUrl as string) ||
        `host=${(config.host as string) || 'localhost'} port=${
          (config.port as number) || 3306
        } user=${(config.user as string) || 'root'} password=${
          (config.password as string) || ''
        } database=${(config.database as string) || ''}`;

      attachQuery = `ATTACH '${connectionUrl.replace(/'/g, "''")}' AS "${attachedDatabaseName}" (TYPE MYSQL)`;
      break;
    }

    case 'sqlite': {
      const sqlitePath =
        (config.path as string) || (config.connectionUrl as string);
      if (!sqlitePath) {
        // Skip this datasource if path is missing (matches main branch behavior)
        return;
      }

      attachQuery = `ATTACH '${sqlitePath.replace(/'/g, "''")}' AS "${attachedDatabaseName}"`;
      break;
    }

    default: {
      throw new Error(
        `Foreign database type not supported: ${provider}. Supported types: postgresql, mysql, sqlite`,
      );
    }
  }

  // Attach the foreign database
  try {
    await conn.run(attachQuery);
    if (connectionUrlForLog) {
      console.log(
        `[ReadDataAgent] Attached ${attachedDatabaseName} with query: ${connectionUrlForLog.replace(/'/g, "''")}`,
      );
    }
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

  const provider = datasource.datasource_provider.toLowerCase();
  const config = datasource.config as Record<string, unknown>;
  const tablesInfo: AttachResult['tables'] = [];

  // Generate a unique database name for this datasource attachment
  const attachedDatabaseName = `ds_${datasource.id.replace(/-/g, '_')}`;

  // Install and load the appropriate extension
  let attachQuery: string;

  switch (provider) {
    case 'postgresql':
    case 'neon':
    case 'supabase': {
      await conn.run('INSTALL postgres');
      await conn.run('LOAD postgres');

      const pgConnectionUrl = config.connectionUrl as string;
      if (!pgConnectionUrl) {
        throw new Error(
          'PostgreSQL datasource requires connectionUrl in config',
        );
      }

      attachQuery = `ATTACH '${pgConnectionUrl.replace(/'/g, "''")}' AS "${attachedDatabaseName}" (TYPE POSTGRES)`;
      break;
    }

    case 'mysql': {
      await conn.run('INSTALL mysql');
      await conn.run('LOAD mysql');

      const mysqlHost = (config.host as string) || 'localhost';
      const mysqlPort = (config.port as number) || 3306;
      const mysqlUser = (config.user as string) || 'root';
      const mysqlPassword = (config.password as string) || '';
      const mysqlDatabase = (config.database as string) || '';

      const mysqlConnectionString = `host=${mysqlHost} port=${mysqlPort} user=${mysqlUser} password=${mysqlPassword} database=${mysqlDatabase}`;
      attachQuery = `ATTACH '${mysqlConnectionString.replace(/'/g, "''")}' AS "${attachedDatabaseName}" (TYPE MYSQL)`;
      break;
    }

    case 'sqlite': {
      const sqlitePath =
        (config.path as string) || (config.connectionUrl as string);
      if (!sqlitePath) {
        throw new Error(
          'SQLite datasource requires path or connectionUrl in config',
        );
      }

      attachQuery = `ATTACH '${sqlitePath.replace(/'/g, "''")}' AS "${attachedDatabaseName}"`;
      break;
    }

    default: {
      throw new Error(
        `Foreign database type not supported: ${provider}. Supported types: postgresql, mysql, sqlite`,
      );
    }
  }

  // Attach the foreign database
  try {
    await conn.run(attachQuery);
    console.debug(`[ForeignDatasourceAttach] Attached ${attachedDatabaseName}`);
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

  // Get list of tables from the attached database
  // Query information_schema to get tables
  let tablesQuery: string;
  if (
    provider === 'postgresql' ||
    provider === 'neon' ||
    provider === 'supabase'
  ) {
    tablesQuery = `
        SELECT table_schema, table_name
        FROM ${attachedDatabaseName}.information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
        AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
      `;
  } else if (provider === 'mysql') {
    tablesQuery = `
        SELECT table_schema, table_name
        FROM ${attachedDatabaseName}.information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
      `;
  } else {
    // SQLite
    tablesQuery = `
        SELECT 'main' as table_schema, name as table_name
        FROM ${attachedDatabaseName}.sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `;
  }

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
