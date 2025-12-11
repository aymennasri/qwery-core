import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { DuckDBInstanceManager } from './duckdb-instance-manager';
import { listAllTables } from './view-registry';

export interface ListAvailableSheetsOptions {
  conversationId: string;
  workspace: string;
  datasourceRepository?: IDatasourceRepository; // Optional for backward compatibility
}

export interface SheetInfo {
  name: string;
  displayName?: string; // Friendly name for display (datasource name)
  type: 'view' | 'table' | 'attached_table';
  datasourceId?: string; // Datasource ID
  datasourceType?: 'duckdb-native' | 'foreign-database'; // Type of datasource
  datasourceProvider?: string; // Provider (gsheet-csv, postgresql, etc.)
  datasourceName?: string; // Datasource name from repository
  database?: string; // For attached tables (e.g., 'ds_xxx')
  schema?: string; // For attached tables
  fullPath?: string; // Full qualified path for attached tables (e.g., 'ds_xxx.public.users')
}

export interface ListAvailableSheetsResult {
  sheets: SheetInfo[];
  count: number;
}

/**
 * Extract datasource ID from database name pattern
 * Converts ds_f6e752e1_6a14_42b9_a33e_0aaf0fcf73e5 back to f6e752e1-6a14-42b9-a33e-0aaf0fcf73e5
 */
function extractDatasourceIdFromDbName(dbName: string): string | null {
  // Pattern: ds_f6e752e1_6a14_42b9_a33e_0aaf0fcf73e5
  // Convert back to: f6e752e1-6a14-42b9-a33e-0aaf0fcf73e5
  if (!dbName.startsWith('ds_')) {
    return null;
  }
  const idPart = dbName.replace('ds_', '');
  // Convert underscores back to hyphens (UUID format)
  const parts = idPart.split('_');
  if (parts.length >= 5) {
    // Reconstruct UUID: f6e752e1-6a14-42b9-a33e-0aaf0fcf73e5
    return `${parts[0]}-${parts[1]}-${parts[2]}-${parts[3]}-${parts.slice(4).join('')}`;
  }
  return null;
}

export const listAvailableSheets = async (
  opts: ListAvailableSheetsOptions,
): Promise<ListAvailableSheetsResult> => {
  const { conversationId, workspace, datasourceRepository } = opts;

  // Get DuckDBInstanceManager wrapper to access viewRegistry and attachedDatasources
  const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);

  if (!wrapper) {
    // If no instance exists, return empty
    return { sheets: [], count: 0 };
  }

  // Get viewRegistry (datasourceId -> viewName) and attachedDatasources Set
  const viewRegistry = wrapper.viewRegistry; // Map<datasourceId, viewName>
  const attachedDatasources = wrapper.attachedDatasources; // Set<datasourceId>

  // Build datasource name map if repository provided
  const datasourceNameMap = new Map<string, string>();
  const datasourceTypeMap = new Map<
    string,
    'duckdb-native' | 'foreign-database'
  >();
  const datasourceProviderMap = new Map<string, string>();

  if (datasourceRepository) {
    // Collect all datasource IDs we need to lookup
    const datasourceIds = new Set<string>();

    // Add IDs from viewRegistry (DuckDB-native views)
    for (const dsId of viewRegistry.keys()) {
      datasourceIds.add(dsId);
      datasourceTypeMap.set(dsId, 'duckdb-native');
    }

    // Add IDs from attachedDatasources (foreign databases)
    for (const dsId of attachedDatasources) {
      datasourceIds.add(dsId);
      datasourceTypeMap.set(dsId, 'foreign-database');
    }

    // Load all datasources to get names and providers
    for (const dsId of datasourceIds) {
      try {
        const datasource = await datasourceRepository.findById(dsId);
        if (datasource) {
          if (datasource.name) {
            datasourceNameMap.set(dsId, datasource.name);
          }
          if (datasource.datasource_provider) {
            datasourceProviderMap.set(dsId, datasource.datasource_provider);
          }
        }
      } catch {
        // Skip if datasource not found
      }
    }
  }

  const sheets: SheetInfo[] = [];

  // FIRST: Add DuckDB-native views from viewRegistry (PRIMARY SOURCE)
  // This is the source of truth for views created from gsheet/csv/etc.
  const conn = await DuckDBInstanceManager.getConnection(
    conversationId,
    workspace,
  );

  try {
    for (const [dsId, viewName] of viewRegistry.entries()) {
      // Verify view actually exists in DuckDB (might have been dropped)
      try {
        const escapedViewName = viewName.replace(/"/g, '""');
        // Test if view exists by trying to query it
        await conn.run(`SELECT 1 FROM "${escapedViewName}" LIMIT 1`);

        // View exists, add it to sheets
        const datasourceName = datasourceNameMap.get(dsId);
        const datasourceProvider = datasourceProviderMap.get(dsId);

        sheets.push({
          name: viewName,
          displayName: datasourceName || viewName,
          type: 'view',
          datasourceId: dsId,
          datasourceType: 'duckdb-native',
          datasourceProvider,
          datasourceName,
        });
      } catch {
        // View doesn't exist in DuckDB (might have been dropped)
        // Remove from viewRegistry to keep it in sync
        viewRegistry.delete(dsId);
      }
    }
  } finally {
    DuckDBInstanceManager.returnConnection(conversationId, workspace, conn);
  }

  // SECOND: Get foreign database tables from listAllTables
  // This finds tables from attached databases (postgres, mysql, etc.)
  const allTables = await listAllTables(conversationId, workspace);

  // Track which views we've already added from viewRegistry to avoid duplicates
  const viewRegistryViewNames = new Set(viewRegistry.values());

  // Also extract IDs from table paths (for foreign DBs) for datasource mapping
  if (datasourceRepository) {
    const additionalDatasourceIds = new Set<string>();
    for (const table of allTables) {
      if (table.includes('.')) {
        const parts = table.split('.');
        if (parts[0]?.startsWith('ds_')) {
          const dsId = extractDatasourceIdFromDbName(parts[0]);
          if (dsId && !datasourceNameMap.has(dsId)) {
            additionalDatasourceIds.add(dsId);
            datasourceTypeMap.set(dsId, 'foreign-database');
          }
        }
      }
    }

    // Load additional datasources
    for (const dsId of additionalDatasourceIds) {
      try {
        const datasource = await datasourceRepository.findById(dsId);
        if (datasource) {
          if (datasource.name) {
            datasourceNameMap.set(dsId, datasource.name);
          }
          if (datasource.datasource_provider) {
            datasourceProviderMap.set(dsId, datasource.datasource_provider);
          }
        }
      } catch {
        // Skip if datasource not found
      }
    }
  }

  for (const table of allTables) {
    // Skip if this view is already added from viewRegistry
    if (viewRegistryViewNames.has(table)) {
      continue;
    }

    // Check if it's a fully qualified path (attached database)
    if (table.includes('.')) {
      const parts = table.split('.').filter(Boolean);
      if (parts.length >= 3) {
        // Format: ds_xxx.schema.table
        const database = parts[0];
        const schema = parts[1];
        const tableName = parts.slice(2).join('.');

        if (!database || !schema || !tableName) {
          continue; // Skip invalid entries
        }

        // Extract datasource ID and get display name
        const dsId = extractDatasourceIdFromDbName(database);
        const datasourceDisplayName =
          dsId && datasourceNameMap.has(dsId)
            ? datasourceNameMap.get(dsId)!
            : database;
        const datasourceType = dsId ? datasourceTypeMap.get(dsId) : undefined;
        const datasourceProvider = dsId
          ? datasourceProviderMap.get(dsId)
          : undefined;

        sheets.push({
          name: tableName,
          displayName: `${datasourceDisplayName}.${schema}.${tableName}`,
          type: 'attached_table',
          datasourceId: dsId || undefined,
          datasourceType: datasourceType,
          datasourceProvider: datasourceProvider,
          datasourceName:
            datasourceDisplayName !== database
              ? datasourceDisplayName
              : undefined,
          database,
          schema,
          fullPath: table,
        });
      } else if (parts.length === 2) {
        // Format: schema.table (less common)
        const schema = parts[0];
        const tableName = parts[1];
        if (schema && tableName) {
          sheets.push({
            name: tableName,
            type: 'attached_table',
            schema,
            fullPath: table,
          });
        }
      } else {
        // Single part - treat as view/table in main database
        // This shouldn't happen if we're using viewRegistry correctly,
        // but handle it anyway
        if (!viewRegistryViewNames.has(table)) {
          sheets.push({
            name: table,
            type: 'view', // Default to view for main database
          });
        }
      }
    } else {
      // Simple name - view or table in main database
      // This shouldn't happen if we're using viewRegistry correctly,
      // but if listAllTables finds something we missed, add it
      if (!viewRegistryViewNames.has(table)) {
        // Try to determine if it's a view or table
        const conn2 = await DuckDBInstanceManager.getConnection(
          conversationId,
          workspace,
        );

        try {
          const escapedName = table.replace(/"/g, '""');
          const checkQuery = `
            SELECT table_type 
            FROM information_schema.tables 
            WHERE table_schema = 'main' AND table_name = '${escapedName}'
          `;
          const resultReader = await conn2.runAndReadAll(checkQuery);
          await resultReader.readAll();
          const rows = resultReader.getRowObjectsJS() as Array<{
            table_type: string;
          }>;

          const tableType =
            rows.length > 0 && rows[0]?.table_type === 'VIEW'
              ? 'view'
              : 'table';

          sheets.push({
            name: table,
            type: tableType,
          });
        } catch {
          // If check fails, default to view
          sheets.push({
            name: table,
            type: 'view',
          });
        } finally {
          DuckDBInstanceManager.returnConnection(
            conversationId,
            workspace,
            conn2,
          );
        }
      }
    }
  }

  return {
    sheets,
    count: sheets.length,
  };
};
