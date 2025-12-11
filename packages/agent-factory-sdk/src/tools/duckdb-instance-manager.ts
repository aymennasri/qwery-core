import type { DuckDBInstance } from '@duckdb/node-api';
import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { loadDatasources, groupDatasourcesByType } from './datasource-loader';
import { attachForeignDatasource } from './foreign-datasource-attach';
import { datasourceToDuckdb } from './datasource-to-duckdb';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

export interface DuckDBInstanceWrapper {
  instance: DuckDBInstance;
  connectionPool: Connection[];
  attachedDatasources: Set<string>; // datasource IDs
  viewRegistry: Map<string, string>; // datasourceId -> viewName
  dbPath: string;
  maxConnections: number;
  activeConnections: number;
}

export interface GetInstanceOptions {
  conversationId: string;
  workspace: string;
  createIfNotExists?: boolean;
}

/**
 * Central DuckDB instance manager
 * Maintains a single persistent DuckDB instance per conversation
 * with connection pooling to avoid race conditions
 */
class DuckDBInstanceManager {
  private instances: Map<string, DuckDBInstanceWrapper> = new Map();
  private readonly maxConnectionsPerInstance = 2; // Start with 2, scale if needed

  /**
   * Get or create a DuckDB instance for a conversation
   */
  async getInstance(opts: GetInstanceOptions): Promise<DuckDBInstanceWrapper> {
    const { conversationId, workspace, createIfNotExists = true } = opts;

    const key = `${workspace}:${conversationId}`;

    // Return existing instance if available
    if (this.instances.has(key)) {
      return this.instances.get(key)!;
    }

    if (!createIfNotExists) {
      throw new Error(
        `DuckDB instance not found for conversation ${conversationId}`,
      );
    }

    // Create new instance
    const { join } = await import('node:path');
    const { mkdir } = await import('node:fs/promises');

    const fileDir = join(workspace, conversationId);
    await mkdir(fileDir, { recursive: true });
    const dbPath = join(fileDir, 'database.db');

    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(dbPath);

    const wrapper: DuckDBInstanceWrapper = {
      instance,
      connectionPool: [],
      attachedDatasources: new Set(),
      viewRegistry: new Map(),
      dbPath,
      maxConnections: this.maxConnectionsPerInstance,
      activeConnections: 0,
    };

    this.instances.set(key, wrapper);
    console.log(
      `[DuckDBInstanceManager] Created instance for conversation ${conversationId}`,
    );

    return wrapper;
  }

  /**
   * Get the wrapper for a conversation (for accessing viewRegistry, etc.)
   * Returns null if instance doesn't exist
   */
  getWrapper(
    conversationId: string,
    workspace: string,
  ): DuckDBInstanceWrapper | null {
    const key = `${workspace}:${conversationId}`;
    return this.instances.get(key) || null;
  }

  /**
   * Get a connection from the pool (or create one if pool is empty)
   */
  async getConnection(
    conversationId: string,
    workspace: string,
  ): Promise<Connection> {
    const wrapper = await this.getInstance({
      conversationId,
      workspace,
      createIfNotExists: true,
    });

    // Return connection from pool if available
    if (wrapper.connectionPool.length > 0) {
      const conn = wrapper.connectionPool.pop()!;
      wrapper.activeConnections++;
      return conn;
    }

    // Create new connection if pool is empty and under limit
    if (wrapper.activeConnections < wrapper.maxConnections) {
      const conn = await wrapper.instance.connect();
      wrapper.activeConnections++;
      return conn;
    }

    // Wait for a connection to become available (simple retry)
    // In production, you might want a proper queue here
    await new Promise((resolve) => setTimeout(resolve, 100));
    return this.getConnection(conversationId, workspace);
  }

  /**
   * Return a connection to the pool
   */
  returnConnection(
    conversationId: string,
    workspace: string,
    connection: Connection,
  ): void {
    const key = `${workspace}:${conversationId}`;
    const wrapper = this.instances.get(key);

    if (!wrapper) {
      // If instance doesn't exist, just close the connection
      connection.closeSync();
      return;
    }

    // Return to pool
    wrapper.connectionPool.push(connection);
    wrapper.activeConnections--;

    if (wrapper.activeConnections < 0) {
      wrapper.activeConnections = 0;
    }
  }

  /**
   * Sync datasources based on checked state from UI
   * Attaches/detaches foreign DBs and creates/drops views
   */
  async syncDatasources(
    conversationId: string,
    workspace: string,
    checkedDatasourceIds: string[],
    datasourceRepository: IDatasourceRepository,
  ): Promise<void> {
    console.log(
      `[DuckDBInstanceManager] Syncing ${checkedDatasourceIds.length} datasource(s) for conversation ${conversationId}`,
    );

    const wrapper = await this.getInstance({
      conversationId,
      workspace,
      createIfNotExists: true,
    });

    const conn = await this.getConnection(conversationId, workspace);

    try {
      const checkedSet = new Set(checkedDatasourceIds);
      const currentAttached = wrapper.attachedDatasources;
      const currentViews = wrapper.viewRegistry;

      // REMOVE: Verbose state logging - only log if needed for debugging

      // Load all datasources to get their types
      const allDatasourceIds = Array.from(
        new Set([
          ...checkedDatasourceIds,
          ...currentAttached,
          ...currentViews.keys(),
        ]),
      );
      const loaded = await loadDatasources(
        allDatasourceIds,
        datasourceRepository,
      );
      const { duckdbNative, foreignDatabases } = groupDatasourcesByType(loaded);

      // Detach unchecked foreign databases
      for (const { datasource } of foreignDatabases) {
        const dsId = datasource.id;
        if (currentAttached.has(dsId) && !checkedSet.has(dsId)) {
          console.log(`[DuckDBInstanceManager] Detaching datasource: ${dsId}`);
          await this.detachForeignDB(conn, dsId);
          currentAttached.delete(dsId);
          console.log(`[DuckDBInstanceManager] Detached: ${dsId}`);
        }
      }

      // Drop views for unchecked DuckDB-native datasources
      for (const [dsId, viewName] of currentViews.entries()) {
        if (!checkedSet.has(dsId)) {
          try {
            const escapedViewName = viewName.replace(/"/g, '""');
            await conn.run(`DROP VIEW IF EXISTS "${escapedViewName}"`);
            currentViews.delete(dsId);
            console.log(
              `[DuckDBInstanceManager] Dropped view: ${viewName} (datasource: ${dsId})`,
            );
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.warn(
              `[DuckDBInstanceManager] Failed to drop view ${viewName}: ${errorMsg}`,
            );
          }
        }
      }

      // Attach newly checked foreign databases
      for (const { datasource } of foreignDatabases) {
        const dsId = datasource.id;
        if (!currentAttached.has(dsId) && checkedSet.has(dsId)) {
          try {
            console.log(
              `[DuckDBInstanceManager] Attaching datasource: ${dsId}`,
            );
            await attachForeignDatasource({
              connection: conn,
              datasource,
            });
            currentAttached.add(dsId);
            console.log(`[DuckDBInstanceManager] Attached: ${dsId}`);
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[DuckDBInstanceManager] Failed to attach datasource ${dsId}: ${errorMsg}`,
            );
          }
        }
      }

      // Create views for newly checked DuckDB-native datasources
      for (const { datasource } of duckdbNative) {
        const dsId = datasource.id;
        if (!currentViews.has(dsId) && checkedSet.has(dsId)) {
          try {
            const result = await datasourceToDuckdb({
              connection: conn,
              datasource,
            });
            currentViews.set(dsId, result.viewName);
            console.log(
              `[DuckDBInstanceManager] Created view: ${result.viewName} (datasource: ${dsId})`,
            );
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(
              `[DuckDBInstanceManager] Failed to create view for datasource ${dsId}: ${errorMsg}`,
            );
          }
        }
      }
    } finally {
      this.returnConnection(conversationId, workspace, conn);
    }
  }

  /**
   * Detach a foreign database
   * Note: DuckDB doesn't support IF EXISTS with DETACH, so we catch errors
   */
  private async detachForeignDB(
    conn: Connection,
    datasourceId: string,
  ): Promise<void> {
    const attachedDatabaseName = `ds_${datasourceId.replace(/-/g, '_')}`;
    const escapedDbName = attachedDatabaseName.replace(/"/g, '""');

    try {
      // DuckDB doesn't support DETACH IF EXISTS, so we just try to detach
      // and catch errors if it doesn't exist
      await conn.run(`DETACH "${escapedDbName}"`);
      console.log(
        `[DuckDBInstanceManager] Successfully detached ${attachedDatabaseName}`,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      // If already detached or doesn't exist, that's fine - just log
      if (
        errorMsg.includes('not found') ||
        errorMsg.includes('does not exist') ||
        errorMsg.includes('not attached')
      ) {
        console.debug(
          `[DuckDBInstanceManager] ${attachedDatabaseName} already detached or doesn't exist`,
        );
      } else {
        // Log other errors as warnings
        console.warn(
          `[DuckDBInstanceManager] Failed to detach ${attachedDatabaseName}: ${errorMsg}`,
        );
      }
    }
  }

  /**
   * Close a specific instance
   */
  async closeInstance(
    conversationId: string,
    workspace: string,
  ): Promise<void> {
    const key = `${workspace}:${conversationId}`;
    const wrapper = this.instances.get(key);

    if (!wrapper) {
      return;
    }

    // Close all connections in pool
    for (const conn of wrapper.connectionPool) {
      try {
        conn.closeSync();
      } catch (error) {
        console.warn(
          `[DuckDBInstanceManager] Error closing connection: ${error}`,
        );
      }
    }

    // Close instance
    try {
      wrapper.instance.closeSync();
    } catch (error) {
      console.warn(`[DuckDBInstanceManager] Error closing instance: ${error}`);
    }

    this.instances.delete(key);
    console.log(
      `[DuckDBInstanceManager] Closed instance for conversation ${conversationId}`,
    );
  }

  /**
   * Close all instances
   */
  async closeAll(): Promise<void> {
    const keys = Array.from(this.instances.keys());

    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 2) {
        const workspace = parts[0];
        const conversationId = parts.slice(1).join(':'); // Handle workspace paths with colons
        if (workspace && conversationId) {
          await this.closeInstance(conversationId, workspace);
        }
      }
    }

    console.log('[DuckDBInstanceManager] Closed all instances');
  }
}

// Singleton instance
const instanceManager = new DuckDBInstanceManager();
export { instanceManager as DuckDBInstanceManager };
