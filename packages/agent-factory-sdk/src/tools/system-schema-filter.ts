/**
 * System schema filtering utility
 * Uses extension abstraction to determine system schemas per datasource provider
 */

// Default system schemas by provider (can be extended by extensions)
const DEFAULT_SYSTEM_SCHEMAS: Record<string, string[]> = {
  postgresql: [
    'information_schema',
    'pg_catalog',
    'pg_toast',
    'pg_temp',
    'pg_toast_temp',
    'supabase_migrations',
    'vault',
    'storage',
    'realtime',
    'graphql',
    'graphql_public',
    'auth',
    'extensions',
    'pgbouncer',
  ],
  neon: [
    'information_schema',
    'pg_catalog',
    'pg_toast',
    'pg_temp',
    'pg_toast_temp',
    'supabase_migrations',
    'vault',
    'storage',
    'realtime',
    'graphql',
    'graphql_public',
    'auth',
    'extensions',
    'pgbouncer',
  ],
  supabase: [
    'information_schema',
    'pg_catalog',
    'pg_toast',
    'pg_temp',
    'pg_toast_temp',
    'supabase_migrations',
    'vault',
    'storage',
    'realtime',
    'graphql',
    'graphql_public',
    'auth',
    'extensions',
    'pgbouncer',
  ],
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  clickhouse: ['system', 'information_schema', 'INFORMATION_SCHEMA'],
  sqlite: ['sqlite_master'],
};

/**
 * Get system schemas for a datasource provider
 * Uses extension abstraction when available, falls back to defaults
 */
export async function getSystemSchemas(
  datasourceProvider: string,
): Promise<Set<string>> {
  const provider = datasourceProvider.toLowerCase();

  // Try to get from extension metadata if available
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore - Dynamic import, module will be available at runtime
    const extensionsSdk = await import('@qwery/extensions-sdk');
    const { getDiscoveredDatasource } = extensionsSdk;

    const extension = await getDiscoveredDatasource(provider);
    if (extension) {
      // Extensions can define system schemas in their metadata
      // For now, we use the defaults but this can be extended
      // by adding a systemSchemas property to extension metadata
    }
  } catch {
    // Extension not available, use defaults
    console.debug(
      `[SystemSchemaFilter] Extension not available for ${provider}, using defaults`,
    );
  }

  // Return system schemas for provider, or empty set if unknown
  const schemas = DEFAULT_SYSTEM_SCHEMAS[provider] || [];
  return new Set(schemas.map((s) => s.toLowerCase()));
}

/**
 * Check if a schema is a system schema for the given provider
 */
export async function isSystemSchema(
  schemaName: string,
  datasourceProvider: string,
): Promise<boolean> {
  const systemSchemas = await getSystemSchemas(datasourceProvider);
  return systemSchemas.has(schemaName.toLowerCase());
}

/**
 * Get all known system schemas (union of all providers)
 * Useful for filtering when provider is unknown
 */
export function getAllSystemSchemas(): Set<string> {
  const allSchemas = new Set<string>();
  for (const schemas of Object.values(DEFAULT_SYSTEM_SCHEMAS)) {
    for (const schema of schemas) {
      allSchemas.add(schema.toLowerCase());
    }
  }
  return allSchemas;
}

/**
 * Check if a table name indicates a system table
 * (regardless of provider)
 */
export function isSystemTableName(tableName: string): boolean {
  const name = tableName.toLowerCase();
  return (
    name.startsWith('pg_') ||
    name.startsWith('sqlite_') ||
    name.startsWith('duckdb_') ||
    name.startsWith('_') ||
    name.includes('_migrations') ||
    name.includes('_secrets')
  );
}
