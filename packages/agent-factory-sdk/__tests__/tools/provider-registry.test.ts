import { describe, it, expect } from 'vitest';
import {
  getProviderMapping,
  isProviderSupported,
  getSupportedProviders,
} from '../../src/tools/provider-registry';

describe('Provider Registry', () => {
  describe('getProviderMapping', () => {
    it('should map postgresql to POSTGRES', async () => {
      const mapping = await getProviderMapping('postgresql');
      expect(mapping).not.toBeNull();
      expect(mapping?.duckdbType).toBe('POSTGRES');
      expect(mapping?.requiresExtension).toBe(true);
      expect(mapping?.extensionName).toBe('postgres');
    });

    it('should map postgresql-supabase to POSTGRES', async () => {
      const mapping = await getProviderMapping('postgresql-supabase');
      expect(mapping).not.toBeNull();
      expect(mapping?.duckdbType).toBe('POSTGRES');
      expect(mapping?.requiresExtension).toBe(true);
      expect(mapping?.extensionName).toBe('postgres');
    });

    it('should map postgresql-neon to POSTGRES', async () => {
      const mapping = await getProviderMapping('postgresql-neon');
      expect(mapping).not.toBeNull();
      expect(mapping?.duckdbType).toBe('POSTGRES');
      expect(mapping?.requiresExtension).toBe(true);
      expect(mapping?.extensionName).toBe('postgres');
    });

    it('should map mysql to MYSQL', async () => {
      const mapping = await getProviderMapping('mysql');
      expect(mapping).not.toBeNull();
      expect(mapping?.duckdbType).toBe('MYSQL');
      expect(mapping?.requiresExtension).toBe(true);
      expect(mapping?.extensionName).toBe('mysql');
    });

    it('should map sqlite to SQLITE', async () => {
      const mapping = await getProviderMapping('sqlite');
      expect(mapping).not.toBeNull();
      expect(mapping?.duckdbType).toBe('SQLITE');
      expect(mapping?.requiresExtension).toBe(false);
    });

    it('should map duckdb to SQLITE (DuckDB files can be attached)', async () => {
      const mapping = await getProviderMapping('duckdb');
      expect(mapping).not.toBeNull();
      expect(mapping?.duckdbType).toBe('SQLITE');
      expect(mapping?.requiresExtension).toBe(false);
    });

    it('should return null for unsupported providers', async () => {
      const mapping = await getProviderMapping('clickhouse-node');
      expect(mapping).toBeNull();
    });

    it('should handle case-insensitive provider IDs', async () => {
      const mapping1 = await getProviderMapping('POSTGRESQL');
      const mapping2 = await getProviderMapping('PostgreSQL');
      const mapping3 = await getProviderMapping('postgresql');

      expect(mapping1?.duckdbType).toBe('POSTGRES');
      expect(mapping2?.duckdbType).toBe('POSTGRES');
      expect(mapping3?.duckdbType).toBe('POSTGRES');
    });
  });

  describe('getConnectionString', () => {
    it('should extract connectionUrl for PostgreSQL', async () => {
      const mapping = await getProviderMapping('postgresql');
      expect(mapping).not.toBeNull();

      const config = { connectionUrl: 'postgresql://user:pass@host:5432/db' };
      const connectionString = mapping!.getConnectionString(config);
      // Connection string should have sslmode=prefer added by default
      expect(connectionString).toBe('postgresql://user:pass@host:5432/db');
    });

    it('should throw error if connectionUrl missing for PostgreSQL', async () => {
      const mapping = await getProviderMapping('postgresql');
      expect(mapping).not.toBeNull();

      const config = {};
      expect(() => mapping!.getConnectionString(config)).toThrow(
        'PostgreSQL datasource requires connectionUrl in config',
      );
    });

    it('should extract connectionUrl for MySQL', async () => {
      const mapping = await getProviderMapping('mysql');
      expect(mapping).not.toBeNull();

      const config = { connectionUrl: 'mysql://user:pass@host:3306/db' };
      const connectionString = mapping!.getConnectionString(config);
      expect(connectionString).toBe('mysql://user:pass@host:3306/db');
    });

    it('should build connection string from fields for MySQL', async () => {
      const mapping = await getProviderMapping('mysql');
      expect(mapping).not.toBeNull();

      const config = {
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'secret',
        database: 'testdb',
      };
      const connectionString = mapping!.getConnectionString(config);
      expect(connectionString).toBe(
        'host=localhost port=3306 user=root password=secret database=testdb',
      );
    });

    it('should extract path for SQLite', async () => {
      const mapping = await getProviderMapping('sqlite');
      expect(mapping).not.toBeNull();

      const config = { path: '/path/to/database.db' };
      const connectionString = mapping!.getConnectionString(config);
      expect(connectionString).toBe('/path/to/database.db');
    });

    it('should use connectionUrl as fallback for SQLite', async () => {
      const mapping = await getProviderMapping('sqlite');
      expect(mapping).not.toBeNull();

      const config = { connectionUrl: '/path/to/database.db' };
      const connectionString = mapping!.getConnectionString(config);
      expect(connectionString).toBe('/path/to/database.db');
    });

    it('should extract database path for DuckDB', async () => {
      const mapping = await getProviderMapping('duckdb');
      expect(mapping).not.toBeNull();

      const config = { database: '/path/to/database.duckdb' };
      const connectionString = mapping!.getConnectionString(config);
      expect(connectionString).toBe('/path/to/database.duckdb');
    });

    it('should use path as fallback for DuckDB', async () => {
      const mapping = await getProviderMapping('duckdb');
      expect(mapping).not.toBeNull();

      const config = { path: '/path/to/database.duckdb' };
      const connectionString = mapping!.getConnectionString(config);
      expect(connectionString).toBe('/path/to/database.duckdb');
    });
  });

  describe('getTablesQuery', () => {
    it('should generate PostgreSQL table query', async () => {
      const mapping = await getProviderMapping('postgresql');
      expect(mapping).not.toBeNull();

      const query = mapping!.getTablesQuery('ds_test_db');
      expect(query).toContain('ds_test_db.information_schema.tables');
      expect(query).toContain(
        "table_schema NOT IN ('information_schema', 'pg_catalog')",
      );
    });

    it('should generate MySQL table query', async () => {
      const mapping = await getProviderMapping('mysql');
      expect(mapping).not.toBeNull();

      const query = mapping!.getTablesQuery('ds_test_db');
      expect(query).toContain('ds_test_db.information_schema.tables');
      expect(query).toContain(
        "table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')",
      );
    });

    it('should generate SQLite table query', async () => {
      const mapping = await getProviderMapping('sqlite');
      expect(mapping).not.toBeNull();

      const query = mapping!.getTablesQuery('ds_test_db');
      expect(query).toContain('ds_test_db.sqlite_master');
      expect(query).toContain("name NOT LIKE 'sqlite_%'");
    });
  });

  describe('isProviderSupported', () => {
    it('should return true for supported providers', async () => {
      expect(await isProviderSupported('postgresql')).toBe(true);
      expect(await isProviderSupported('postgresql-supabase')).toBe(true);
      expect(await isProviderSupported('postgresql-neon')).toBe(true);
      expect(await isProviderSupported('mysql')).toBe(true);
      expect(await isProviderSupported('sqlite')).toBe(true);
    });

    it('should return false for unsupported providers', async () => {
      expect(await isProviderSupported('clickhouse-node')).toBe(false);
      expect(await isProviderSupported('pglite')).toBe(false);
      expect(await isProviderSupported('duckdb-wasm')).toBe(false);
    });

    it('should return true for duckdb provider', async () => {
      expect(await isProviderSupported('duckdb')).toBe(true);
    });
  });

  describe('getSupportedProviders', () => {
    it('should return list of supported providers', async () => {
      const providers = await getSupportedProviders();
      expect(providers).toContain('postgresql');
      expect(providers).toContain('mysql');
      expect(providers).toContain('sqlite');
      expect(providers.length).toBeGreaterThanOrEqual(3);
    });
  });
});
