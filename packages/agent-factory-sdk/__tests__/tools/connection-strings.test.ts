import { describe, it, expect } from 'vitest';
import {
  getProviderMapping,
  isProviderSupported,
} from '../../src/tools/provider-registry';

describe('Connection String Tests', () => {
  describe('Supabase Connection', () => {
    it('should extract Supabase connection string correctly', async () => {
      const mapping = await getProviderMapping('postgresql-supabase');
      expect(mapping).not.toBeNull();

      const config = {
        connectionUrl:
          'postgresql://postgres:testpass@db.example.supabase.co:5432/postgres',
      };

      const connectionString = mapping!.getConnectionString(config);
      // Code adds sslmode=prefer if not present for DuckDB compatibility
      expect(connectionString).toContain('supabase.co');
      expect(connectionString).toContain('postgres:testpass');
    });

    it('should generate valid ATTACH query for Supabase', async () => {
      const mapping = await getProviderMapping('postgresql-supabase');
      expect(mapping).not.toBeNull();

      const config = {
        connectionUrl:
          'postgresql://postgres:testpass@db.example.supabase.co:5432/postgres',
      };

      const connectionString = mapping!.getConnectionString(config);
      const attachQuery = `ATTACH '${connectionString.replace(/'/g, "''")}' AS "ds_test" (TYPE POSTGRES)`;

      expect(attachQuery).toContain('TYPE POSTGRES');
      expect(attachQuery).toContain('ds_test');
      expect(attachQuery).toContain('supabase.co');
    });
  });

  describe('Neon Connection', () => {
    it('should extract Neon connection string correctly and remove channel_binding', async () => {
      const mapping = await getProviderMapping('postgresql-neon');
      expect(mapping).not.toBeNull();

      const config = {
        connectionUrl:
          'postgresql://neondb_owner:testpass@ep-example-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      };

      const connectionString = mapping!.getConnectionString(config);
      // Should remove channel_binding (DuckDB doesn't support it)
      expect(connectionString).not.toContain('channel_binding');
      expect(connectionString).toContain('neon.tech');
      expect(connectionString).toContain('neondb_owner');
      expect(connectionString).toContain('sslmode=require');
    });

    it('should generate valid ATTACH query for Neon', async () => {
      const mapping = await getProviderMapping('postgresql-neon');
      expect(mapping).not.toBeNull();

      const config = {
        connectionUrl:
          'postgresql://neondb_owner:testpass@ep-example-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require',
      };

      const connectionString = mapping!.getConnectionString(config);
      const attachQuery = `ATTACH '${connectionString.replace(/'/g, "''")}' AS "ds_test" (TYPE POSTGRES)`;

      expect(attachQuery).toContain('TYPE POSTGRES');
      expect(attachQuery).toContain('ds_test');
      expect(attachQuery).toContain('neon.tech');
      // Code keeps existing sslmode (require) if set, doesn't change to prefer
      expect(connectionString).toContain('sslmode=require');
      expect(connectionString).not.toContain('channel_binding');
    });
  });

  describe('Provider Support', () => {
    it('should support postgresql-supabase', async () => {
      expect(await isProviderSupported('postgresql-supabase')).toBe(true);
    });

    it('should support postgresql-neon', async () => {
      expect(await isProviderSupported('postgresql-neon')).toBe(true);
    });

    it('should recognize both as PostgreSQL type', async () => {
      const supabaseMapping = await getProviderMapping('postgresql-supabase');
      const neonMapping = await getProviderMapping('postgresql-neon');

      expect(supabaseMapping?.duckdbType).toBe('POSTGRES');
      expect(neonMapping?.duckdbType).toBe('POSTGRES');
      expect(supabaseMapping?.extensionName).toBe('postgres');
      expect(neonMapping?.extensionName).toBe('postgres');
    });
  });

  describe('Connection String Escaping', () => {
    it('should properly escape single quotes in connection strings', async () => {
      const mapping = await getProviderMapping('postgresql');
      expect(mapping).not.toBeNull();

      // Connection string with single quote (unlikely but possible)
      const config = {
        connectionUrl: "postgresql://user:pass'word@host:5432/db",
      };

      const connectionString = mapping!.getConnectionString(config);
      const escaped = connectionString.replace(/'/g, "''");
      const attachQuery = `ATTACH '${escaped}' AS "ds_test" (TYPE POSTGRES)`;

      // Should have double single quotes for escaping
      expect(escaped).toContain("''");
      expect(attachQuery).toContain("pass''word");
    });
  });
});
