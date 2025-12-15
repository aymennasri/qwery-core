/**
 * Provider Registry - Abstraction layer for mapping datasource providers to DuckDB foreign database types
 *
 * This module provides a clean abstraction that:
 * 1. Maps any datasource provider ID to its underlying DuckDB foreign database type
 * 2. Handles connection string extraction from config
 * 3. Generates appropriate table queries per database type
 * 4. Uses extension discovery to dynamically determine mappings
 */

export type DuckDBForeignType = 'POSTGRES' | 'MYSQL' | 'SQLITE';

export interface ProviderMapping {
  /** The underlying DuckDB foreign database type */
  duckdbType: DuckDBForeignType;
  /** Function to extract connection string from datasource config */
  getConnectionString: (config: Record<string, unknown>) => string;
  /** Function to generate the table list query */
  getTablesQuery: (attachedDatabaseName: string) => string;
  /** Whether this provider requires DuckDB extension installation */
  requiresExtension: boolean;
  /** The DuckDB extension name to install (if requiresExtension is true) */
  extensionName?: string;
}

/**
 * Provider ID patterns that map to specific database types
 * This allows us to handle variants like postgresql-supabase, postgresql-neon, etc.
 */
const PROVIDER_PATTERNS: Array<{
  pattern: RegExp;
  mapping: Omit<ProviderMapping, 'getConnectionString' | 'getTablesQuery'>;
}> = [
  {
    pattern: /^postgresql(-.*)?$/i,
    mapping: {
      duckdbType: 'POSTGRES',
      requiresExtension: true,
      extensionName: 'postgres',
    },
  },
  {
    pattern: /^mysql$/i,
    mapping: {
      duckdbType: 'MYSQL',
      requiresExtension: true,
      extensionName: 'mysql',
    },
  },
  {
    pattern: /^sqlite$/i,
    mapping: {
      duckdbType: 'SQLITE',
      requiresExtension: false,
    },
  },
  {
    pattern: /^duckdb$/i,
    mapping: {
      duckdbType: 'SQLITE', // DuckDB can attach other DuckDB files like SQLite
      requiresExtension: false,
    },
  },
];

/**
 * Get provider mapping for a datasource provider ID
 * Uses pattern matching and extension discovery to determine the mapping
 */
export async function getProviderMapping(
  providerId: string,
): Promise<ProviderMapping | null> {
  const provider = providerId.toLowerCase();

  // Try pattern matching first
  for (const { pattern, mapping } of PROVIDER_PATTERNS) {
    if (pattern.test(provider)) {
      return {
        ...mapping,
        getConnectionString: getConnectionStringForType(mapping.duckdbType),
        getTablesQuery: getTablesQueryForType(mapping.duckdbType),
      };
    }
  }

  // Try extension discovery as fallback
  try {
    const extensionsSdk = await import('@qwery/extensions-sdk');
    const { getDiscoveredDatasource } = extensionsSdk;
    const extension = await getDiscoveredDatasource(provider);

    if (extension) {
      // Infer from provider ID or extension metadata
      // For now, we'll use pattern matching, but this can be extended
      // to read metadata from extensions in the future
      return null;
    }
  } catch {
    // Extension SDK not available, continue with null
  }

  return null;
}

/**
 * Get connection string extractor for a specific DuckDB foreign type
 */
function getConnectionStringForType(
  type: DuckDBForeignType,
): (config: Record<string, unknown>) => string {
  switch (type) {
    case 'POSTGRES': {
      return (config) => {
        const connectionUrl = config.connectionUrl as string;
        if (!connectionUrl) {
          throw new Error(
            'PostgreSQL datasource requires connectionUrl in config',
          );
        }
        // Remove channel_binding parameter as DuckDB's PostgreSQL extension doesn't support it
        // Keep sslmode as-is (both prefer and require work, tested with actual connections)
        try {
          const url = new URL(connectionUrl);
          url.searchParams.delete('channel_binding');

          return url.toString();
        } catch {
          // Fallback: simple string replacement if URL parsing fails
          // This handles edge cases where URL might not parse correctly
          let cleaned = connectionUrl;
          // Remove channel_binding parameter using regex
          cleaned = cleaned.replace(/[&?]channel_binding=[^&]*/g, '');
          cleaned = cleaned.replace(/channel_binding=[^&]*&?/g, '');
          // Change sslmode=disable to prefer (servers require SSL)
          cleaned = cleaned.replace(/sslmode=disable/g, 'sslmode=prefer');
          // Ensure sslmode is present if it was removed
          if (!cleaned.includes('sslmode=')) {
            if (cleaned.includes('?')) {
              cleaned += '&sslmode=prefer';
            } else {
              cleaned += '?sslmode=prefer';
            }
          }
          return cleaned;
        }
      };
    }

    case 'MYSQL': {
      return (config) => {
        const connectionUrl = config.connectionUrl as string;
        if (connectionUrl) {
          return connectionUrl;
        }

        // Build connection string from individual fields
        const host = (config.host as string) || 'localhost';
        const port = (config.port as number) || 3306;
        const user = (config.user as string) || 'root';
        const password = (config.password as string) || '';
        const database = (config.database as string) || '';

        return `host=${host} port=${port} user=${user} password=${password} database=${database}`;
      };
    }

    case 'SQLITE': {
      return (config) => {
        // For SQLite and DuckDB, we can use path, database, or connectionUrl
        const path =
          (config.path as string) ||
          (config.database as string) ||
          (config.connectionUrl as string);
        if (!path) {
          throw new Error(
            'SQLite/DuckDB datasource requires path, database, or connectionUrl in config',
          );
        }
        return path;
      };
    }
  }
}

/**
 * Get table list query generator for a specific DuckDB foreign type
 */
function getTablesQueryForType(
  type: DuckDBForeignType,
): (attachedDatabaseName: string) => string {
  switch (type) {
    case 'POSTGRES': {
      return (attachedDatabaseName) => `
        SELECT table_schema, table_name
        FROM ${attachedDatabaseName}.information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'pg_catalog')
        AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
      `;
    }

    case 'MYSQL': {
      return (attachedDatabaseName) => `
        SELECT table_schema, table_name
        FROM ${attachedDatabaseName}.information_schema.tables
        WHERE table_schema NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys')
        AND table_type = 'BASE TABLE'
        ORDER BY table_schema, table_name
      `;
    }

    case 'SQLITE': {
      return (attachedDatabaseName) => {
        // For SQLite and DuckDB files, use sqlite_master
        // DuckDB files are compatible with SQLite's sqlite_master table
        return `
        SELECT 'main' as table_schema, name as table_name
        FROM ${attachedDatabaseName}.sqlite_master
        WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE 'duckdb_%'
        ORDER BY name
      `;
      };
    }
  }
}

/**
 * Check if a provider is supported for DuckDB foreign database attachment
 */
export async function isProviderSupported(
  providerId: string,
): Promise<boolean> {
  const mapping = await getProviderMapping(providerId);
  return mapping !== null;
}

/**
 * Get all supported provider IDs from extensions
 * Useful for validation and error messages
 * Returns all datasource IDs that can be attached as foreign databases
 */
export async function getSupportedProviders(): Promise<string[]> {
  const providers: Set<string> = new Set();

  // Add base providers from patterns
  providers.add('postgresql');
  providers.add('mysql');
  providers.add('sqlite');

  // Try to discover additional providers from extensions
  try {
    const extensionsSdk = await import('@qwery/extensions-sdk');
    const { getDiscoveredDatasources } = extensionsSdk;
    const datasources = await getDiscoveredDatasources();

    for (const ds of datasources) {
      // Check if this datasource matches any of our patterns
      const mapping = await getProviderMapping(ds.id);
      if (mapping) {
        providers.add(ds.id);
      }
    }
  } catch {
    // Extension SDK not available, return base providers
  }

  // Sort for consistent error messages
  return Array.from(providers).sort();
}
