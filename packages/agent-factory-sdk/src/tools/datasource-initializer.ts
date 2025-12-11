import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { loadDatasources, groupDatasourcesByType } from './datasource-loader';
import { datasourceToDuckdb } from './datasource-to-duckdb';
import { attachForeignDatasource } from './foreign-datasource-attach';
import { DuckDBInstanceManager } from './duckdb-instance-manager';

export interface InitializeDatasourcesOptions {
  conversationId: string;
  datasourceIds: string[];
  datasourceRepository: IDatasourceRepository;
  workspace: string;
  checkedDatasourceIds?: string[]; // For syncing state with UI
}

export interface InitializationResult {
  success: boolean;
  datasourceId: string;
  datasourceName: string;
  viewsCreated: number;
  error?: string;
}

/**
 * Initialize all datasources for a conversation
 * Creates DuckDB views for each datasource so they can be queried together
 */
export async function initializeDatasources(
  opts: InitializeDatasourcesOptions,
): Promise<InitializationResult[]> {
  const {
    conversationId,
    datasourceIds,
    datasourceRepository,
    workspace,
    checkedDatasourceIds,
  } = opts;

  if (datasourceIds.length === 0) {
    return [];
  }

  // FILTER: Only initialize checked datasources if checkedDatasourceIds provided
  const datasourcesToInitialize = checkedDatasourceIds
    ? datasourceIds.filter((id) => checkedDatasourceIds.includes(id))
    : datasourceIds;

  if (datasourcesToInitialize.length === 0) {
    return [];
  }

  // Get central instance
  const instanceWrapper = await DuckDBInstanceManager.getInstance({
    conversationId,
    workspace,
    createIfNotExists: true,
  });

  // Get connection from pool
  const conn = await DuckDBInstanceManager.getConnection(
    conversationId,
    workspace,
  );

  // Load only the datasources we're initializing
  const loaded = await loadDatasources(
    datasourcesToInitialize,
    datasourceRepository,
  );
  const { duckdbNative, foreignDatabases } = groupDatasourcesByType(loaded);

  const results: InitializationResult[] = [];

  try {
    // Initialize DuckDB-native datasources using same connection
    for (const { datasource } of duckdbNative) {
      try {
        // Create views for file-based datasources (csv/gsheet-csv/json/parquet)
        const result = await datasourceToDuckdb({
          connection: conn,
          datasource,
        });

        // Register view in instance wrapper
        instanceWrapper.viewRegistry.set(datasource.id, result.viewName);

        results.push({
          success: true,
          datasourceId: datasource.id,
          datasourceName: datasource.name,
          viewsCreated: 1,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[DatasourceInitializer] Failed to initialize DuckDB-native datasource ${datasource.id}:`,
          errorMsg,
        );
        results.push({
          success: false,
          datasourceId: datasource.id,
          datasourceName: datasource.name,
          viewsCreated: 0,
          error: errorMsg,
        });
      }
    }

    // Initialize foreign databases using same connection
    for (const { datasource } of foreignDatabases) {
      try {
        // Attach foreign database
        const attachResult = await attachForeignDatasource({
          connection: conn,
          datasource,
        });

        // Register attachment in instance wrapper
        instanceWrapper.attachedDatasources.add(datasource.id);

        results.push({
          success: true,
          datasourceId: datasource.id,
          datasourceName: datasource.name,
          viewsCreated: attachResult.tables.length,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.error(
          `[DatasourceInitializer] Failed to initialize foreign datasource ${datasource.id}:`,
          errorMsg,
        );
        results.push({
          success: false,
          datasourceId: datasource.id,
          datasourceName: datasource.name,
          viewsCreated: 0,
          error: errorMsg,
        });
      }
    }

    // REMOVE: The syncDatasources call - we already initialized only checked ones
    // If checkedDatasourceIds was provided, we only initialized those
    // If not provided, we initialized all (backward compatibility)
  } finally {
    // Return connection to pool (don't close)
    DuckDBInstanceManager.returnConnection(conversationId, workspace, conn);
  }

  return results;
}
