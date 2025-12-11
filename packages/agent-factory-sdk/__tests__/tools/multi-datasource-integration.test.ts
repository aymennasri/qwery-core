import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { unlinkSync, existsSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Datasource } from '@qwery/domain/entities';
import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { DuckDBInstanceManager } from '../../src/tools/duckdb-instance-manager';
import { initializeDatasources } from '../../src/tools/datasource-initializer';
import { runQuery } from '../../src/tools/run-query';

// Mock datasource repository
class MockDatasourceRepository
  implements Pick<IDatasourceRepository, 'findById'>
{
  private datasources: Map<string, Datasource> = new Map();

  async findById(id: string): Promise<Datasource | null> {
    return this.datasources.get(id) || null;
  }

  add(datasource: Datasource): void {
    this.datasources.set(datasource.id, datasource);
  }
}

describe('Multi-Datasource Integration', () => {
  const workspace = join(
    tmpdir(),
    `test-workspace-${Date.now()}-${Math.random().toString(36).substring(7)}`,
  );
  const conversationId = 'test-conv-multi-ds';

  const gsheetConfig: Datasource = {
    id: 'gsheet-test-id',
    name: 'Test Google Sheet',
    datasource_provider: 'gsheet-csv',
    config: {
      sharedLink:
        'https://docs.google.com/spreadsheets/d/1yfjcBF4X8waukFdI5u9ctkagFwAn-BRgM5IUCUK1Ay8/edit?gid=0#gid=0',
    },
    slug: 'test-gsheet',
    created_at: new Date(),
    updated_at: new Date(),
  };

  const postgresConfig: Datasource = {
    id: 'postgres-test-id',
    name: 'Test PostgreSQL',
    datasource_provider: 'postgresql',
    config: {
      connectionUrl:
        'postgresql://postgres:YUX5he1NC3cn@angry-star-sooomu.us-west-aws.db.guepard.run:22050/postgres',
    },
    slug: 'test-postgres',
    created_at: new Date(),
    updated_at: new Date(),
  };

  let datasourceRepository: MockDatasourceRepository;

  beforeEach(() => {
    datasourceRepository = new MockDatasourceRepository();
    datasourceRepository.add(gsheetConfig);
    datasourceRepository.add(postgresConfig);
  });

  afterEach(async () => {
    // Clean up instance manager
    try {
      await DuckDBInstanceManager.closeInstance(conversationId, workspace);
    } catch {
      // Ignore cleanup errors
    }

    // Clean up test database files
    try {
      const dbPath = join(workspace, conversationId, 'database.db');
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
      try {
        rmdirSync(join(workspace, conversationId));
        rmdirSync(workspace);
      } catch {
        // Ignore errors
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should initialize GSheet datasource and create view', async () => {
    const results = await initializeDatasources({
      conversationId,
      datasourceIds: [gsheetConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].datasourceId).toBe(gsheetConfig.id);
    expect(results[0].viewsCreated).toBe(1);

    // Verify view registry
    const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    expect(wrapper).toBeDefined();
    expect(wrapper!.viewRegistry.has(gsheetConfig.id)).toBe(true);
    const viewName = wrapper!.viewRegistry.get(gsheetConfig.id);
    expect(viewName).toBeDefined();
    // View name should include datasource ID (hyphens are replaced with underscores in sanitization)
    expect(viewName).toContain(gsheetConfig.id.replace(/-/g, '_'));
  });

  it('should initialize Postgres datasource and attach database', async () => {
    const results = await initializeDatasources({
      conversationId,
      datasourceIds: [postgresConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].datasourceId).toBe(postgresConfig.id);

    // Verify attachment registry
    const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    expect(wrapper).toBeDefined();
    expect(wrapper!.attachedDatasources.has(postgresConfig.id)).toBe(true);
  });

  it('should query GSheet view successfully', async () => {
    // Initialize GSheet
    await initializeDatasources({
      conversationId,
      datasourceIds: [gsheetConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    // Get view name from registry
    const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    const viewName = wrapper!.viewRegistry.get(gsheetConfig.id);
    expect(viewName).toBeDefined();

    // Query the view
    const result = await runQuery({
      conversationId,
      workspace,
      query: `SELECT * FROM "${viewName}" LIMIT 5`,
    });

    expect(result).toBeDefined();
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.columns.length).toBeGreaterThan(0);
  });

  it('should query Postgres tables successfully', async () => {
    // Initialize Postgres
    await initializeDatasources({
      conversationId,
      datasourceIds: [postgresConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    // Query Postgres information_schema
    const result = await runQuery({
      conversationId,
      workspace,
      query: `SELECT table_name FROM ds_${postgresConfig.id.replace(/-/g, '_')}.information_schema.tables LIMIT 5`,
    });

    expect(result).toBeDefined();
    expect(result.rows.length).toBeGreaterThan(0);
  });

  it('should handle multiple datasources in single instance', async () => {
    // Initialize both datasources
    const results = await initializeDatasources({
      conversationId,
      datasourceIds: [gsheetConfig.id, postgresConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.success)).toBe(true);

    // Verify both are registered
    const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    expect(wrapper).toBeDefined();
    expect(wrapper!.viewRegistry.has(gsheetConfig.id)).toBe(true);
    expect(wrapper!.attachedDatasources.has(postgresConfig.id)).toBe(true);
  });

  it('should persist attachments across connections', async () => {
    // Initialize Postgres
    await initializeDatasources({
      conversationId,
      datasourceIds: [postgresConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    // Get first connection and verify attachment
    const conn1 = await DuckDBInstanceManager.getConnection(
      conversationId,
      workspace,
    );
    try {
      const dbList = await conn1.runAndReadAll(
        'SELECT name FROM pragma_database_list',
      );
      await dbList.readAll();
      const databases = dbList.getRowObjectsJS() as Array<{ name: string }>;
      const dbNames = databases.map((d) => d.name);
      expect(dbNames).toContain(`ds_${postgresConfig.id.replace(/-/g, '_')}`);
    } finally {
      DuckDBInstanceManager.returnConnection(conversationId, workspace, conn1);
    }

    // Get second connection (simulates new query)
    const conn2 = await DuckDBInstanceManager.getConnection(
      conversationId,
      workspace,
    );
    try {
      // Verify attachment still exists
      const dbList = await conn2.runAndReadAll(
        'SELECT name FROM pragma_database_list',
      );
      await dbList.readAll();
      const databases = dbList.getRowObjectsJS() as Array<{ name: string }>;
      const dbNames = databases.map((d) => d.name);
      expect(dbNames).toContain(`ds_${postgresConfig.id.replace(/-/g, '_')}`);
    } finally {
      DuckDBInstanceManager.returnConnection(conversationId, workspace, conn2);
    }
  });

  it('should handle concurrent queries without race conditions', async () => {
    // Initialize GSheet
    await initializeDatasources({
      conversationId,
      datasourceIds: [gsheetConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    // Get view name
    const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    const viewName = wrapper!.viewRegistry.get(gsheetConfig.id);

    // Run 5 concurrent queries
    const queries = Array(5)
      .fill(null)
      .map((_, i) =>
        runQuery({
          conversationId,
          workspace,
          query: `SELECT ${i} as num FROM "${viewName}" LIMIT 1`,
        }),
      );

    const results = await Promise.all(queries);

    // All queries should succeed
    results.forEach((result) => {
      expect(result).toBeDefined();
      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  it('should prevent view name collisions with datasource ID', async () => {
    // Create two datasources with same name
    const gsheet1: Datasource = {
      ...gsheetConfig,
      id: 'gsheet-1',
      name: 'Same Name',
    };
    const gsheet2: Datasource = {
      ...gsheetConfig,
      id: 'gsheet-2',
      name: 'Same Name',
    };

    datasourceRepository.add(gsheet1);
    datasourceRepository.add(gsheet2);

    // Initialize both
    await initializeDatasources({
      conversationId,
      datasourceIds: [gsheet1.id, gsheet2.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
    });

    // Verify both views exist with unique names
    const wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    const view1 = wrapper!.viewRegistry.get(gsheet1.id);
    const view2 = wrapper!.viewRegistry.get(gsheet2.id);

    expect(view1).toBeDefined();
    expect(view2).toBeDefined();
    expect(view1).not.toBe(view2);
    // IDs are sanitized (hyphens replaced with underscores)
    expect(view1).toContain(gsheet1.id.replace(/-/g, '_'));
    expect(view2).toContain(gsheet2.id.replace(/-/g, '_'));
  });

  it('should sync datasources based on checked state', async () => {
    // Initialize both datasources
    await initializeDatasources({
      conversationId,
      datasourceIds: [gsheetConfig.id, postgresConfig.id],
      datasourceRepository: datasourceRepository as IDatasourceRepository,
      workspace,
      checkedDatasourceIds: [gsheetConfig.id, postgresConfig.id],
    });

    let wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    expect(wrapper!.viewRegistry.has(gsheetConfig.id)).toBe(true);
    expect(wrapper!.attachedDatasources.has(postgresConfig.id)).toBe(true);

    // Uncheck postgres
    await DuckDBInstanceManager.syncDatasources(
      conversationId,
      workspace,
      [gsheetConfig.id], // Only GSheet checked
      datasourceRepository as IDatasourceRepository,
    );

    wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    expect(wrapper!.viewRegistry.has(gsheetConfig.id)).toBe(true);
    expect(wrapper!.attachedDatasources.has(postgresConfig.id)).toBe(false);

    // Re-check postgres
    await DuckDBInstanceManager.syncDatasources(
      conversationId,
      workspace,
      [gsheetConfig.id, postgresConfig.id],
      datasourceRepository as IDatasourceRepository,
    );

    wrapper = DuckDBInstanceManager.getWrapper(conversationId, workspace);
    expect(wrapper!.attachedDatasources.has(postgresConfig.id)).toBe(true);
  });
});
