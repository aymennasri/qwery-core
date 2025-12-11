import type { Datasource } from '@qwery/domain/entities';
import type { SimpleSchema } from '@qwery/domain/entities';
import type { DuckDBInstance } from '@duckdb/node-api';
import { extractSchema } from './extract-schema';
import { gsheetToDuckdb } from './gsheet-to-duckdb';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

const sanitizeName = (value: string): string => {
  const cleaned = value.replace(/[^a-zA-Z0-9_]/g, '_');
  return /^[a-zA-Z]/.test(cleaned) ? cleaned : `v_${cleaned}`;
};

export interface DatasourceToDuckDbOptions {
  connection: Connection; // Changed from dbPath
  datasource: Datasource;
}

export interface CreateViewResult {
  viewName: string;
  displayName: string;
  schema: SimpleSchema;
}

/**
 * Create DuckDB views from a DuckDB-native datasource
 * This handles datasources like gsheet-csv, duckdb, json-online, etc.
 */
export async function datasourceToDuckdb(
  opts: DatasourceToDuckDbOptions,
): Promise<CreateViewResult> {
  const { connection: conn, datasource } = opts;

  const provider = datasource.datasource_provider;
  const config = datasource.config as Record<string, unknown>;

  // For DuckDB-native providers (gsheet-csv, csv, json-online, parquet-online),
  // we use DuckDB functions directly and don't need driver loading
  const duckdbNativeProviders = [
    'gsheet-csv',
    'csv',
    'json-online',
    'parquet-online',
  ];

  // Generate deterministic view name with datasource ID to prevent collisions
  const baseName =
    datasource.name?.trim() || datasource.datasource_provider?.trim() || 'data';
  const tablePart = 'sheet'; // Default table part for DuckDB-native providers
  // Include datasource ID in view name to prevent collisions
  const viewName = sanitizeName(
    `${datasource.id}_${baseName}_${tablePart}`.toLowerCase(),
  );

  const escapedViewName = viewName.replace(/"/g, '""');

  // Handle DuckDB-native providers that don't need driver loading
  if (duckdbNativeProviders.includes(provider)) {
    // Create view directly from source without a temp table
    if (provider === 'gsheet-csv') {
      const sharedLink =
        (config.sharedLink as string) || (config.url as string);
      if (!sharedLink) {
        throw new Error(
          'gsheet-csv datasource requires sharedLink or url in config',
        );
      }
      await gsheetToDuckdb({
        connection: conn,
        sharedLink,
        viewName: escapedViewName,
      });
    } else if (provider === 'csv') {
      const path = (config.path as string) || (config.url as string);
      if (!path) {
        throw new Error('csv datasource requires path or url in config');
      }
      await conn.run(`
        CREATE OR REPLACE VIEW "${escapedViewName}" AS
        SELECT * FROM read_csv_auto('${path.replace(/'/g, "''")}')
      `);
    } else if (provider === 'json-online') {
      const url = (config.url as string) || (config.path as string);
      if (!url) {
        throw new Error(
          'json-online datasource requires url or path in config',
        );
      }
      await conn.run(`
        CREATE OR REPLACE VIEW "${escapedViewName}" AS
        SELECT * FROM read_json_auto('${url.replace(/'/g, "''")}')
      `);
    } else if (provider === 'parquet-online') {
      const url = (config.url as string) || (config.path as string);
      if (!url) {
        throw new Error(
          'parquet-online datasource requires url or path in config',
        );
      }
      await conn.run(`
        CREATE OR REPLACE VIEW "${escapedViewName}" AS
        SELECT * FROM read_parquet('${url.replace(/'/g, "''")}')
      `);
    }

    // Verify the view was created successfully by trying to query it
    try {
      const verifyReader = await conn.runAndReadAll(
        `SELECT 1 FROM "${escapedViewName}" LIMIT 1`,
      );
      await verifyReader.readAll();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to create or verify view "${viewName}": ${errorMsg}`,
      );
    }

    // Extract schema from the created view using the same connection
    const schema = await extractSchema({
      connection: conn,
      viewName,
    });

    return {
      viewName,
      displayName: viewName,
      schema,
    };
  }

  // For other providers, we need to load the driver and get metadata
  // Dynamically import extensions-sdk to avoid build-time dependency issues
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore - Dynamic import, module will be available at runtime
  const extensionsSdk = await import('@qwery/extensions-sdk');
  const { getDiscoveredDatasource, loadDriverInstance } = extensionsSdk;

  // Get extension metadata to find the driver
  const dsMeta = await getDiscoveredDatasource(datasource.datasource_provider);
  if (!dsMeta) {
    throw new Error(
      `Extension metadata not found for provider: ${datasource.datasource_provider}`,
    );
  }

  // Find the appropriate driver (prefer DuckDB driver if available)
  // If datasource_driver is set, use it; otherwise find the best match
  let driverId: string | undefined = datasource.datasource_driver;

  // If driverId is set but doesn't match any driver, try to find a match
  if (driverId) {
    const foundDriver = dsMeta.drivers.find(
      (d: { id: string }) => d.id === driverId,
    );
    if (!foundDriver) {
      // Driver ID might be just the provider name, try to find matching driver
      const matchingDriver = dsMeta.drivers.find(
        (d: { id: string }) =>
          d.id.includes(driverId!) ||
          d.id.includes(datasource.datasource_provider),
      );
      if (matchingDriver) {
        driverId = matchingDriver.id;
      } else {
        // Reset to undefined to use fallback logic
        driverId = undefined;
      }
    }
  }

  if (!driverId) {
    // Try to find a DuckDB driver first
    const duckdbDriver = dsMeta.drivers.find(
      (d: { id: string }) =>
        d.id.includes('duckdb') ||
        d.id.includes(datasource.datasource_provider),
    );
    if (duckdbDriver) {
      driverId = duckdbDriver.id;
    } else if (dsMeta.drivers.length > 0) {
      // Fallback to first available driver
      driverId = dsMeta.drivers[0]?.id;
    }
  }

  if (!driverId) {
    throw new Error(
      `No driver found for datasource provider: ${datasource.datasource_provider}. Available drivers: ${dsMeta.drivers.map((d: { id: string }) => d.id).join(', ')}`,
    );
  }

  // Load and instantiate the driver
  // Find the driver metadata
  const driverMeta = dsMeta.drivers.find(
    (d: { id: string }) => d.id === driverId,
  );
  if (!driverMeta) {
    throw new Error(
      `Driver ${driverId} not found in extension metadata. Available drivers: ${dsMeta.drivers.map((d: { id: string }) => d.id).join(', ')}`,
    );
  }

  const driver = await loadDriverInstance(
    {
      id: driverId,
      packageDir: dsMeta.packageDir,
      entry: driverMeta.entry,
      runtime: (driverMeta.runtime as 'node' | 'browser') || 'node',
      name: driverMeta.name || driverId,
    },
    datasource.id,
  );

  try {
    // Test connection
    await driver.testConnection(datasource.config);

    // Get metadata to understand the schema
    const metadata = await driver.metadata(datasource.config);

    // Get the first table from metadata
    const firstTable = metadata.tables[0];
    if (!firstTable) {
      throw new Error('No tables found in datasource metadata');
    }

    // Generate deterministic view name with datasource ID to prevent collisions
    const tablePart = firstTable.name || 'table';
    // Include datasource ID in view name to prevent collisions
    const viewNameWithTable = sanitizeName(
      `${datasource.id}_${baseName}_${tablePart}`.toLowerCase(),
    );

    const escapedViewNameWithTable = viewNameWithTable.replace(/"/g, '""');

    // Fallback: select from driver-accessible table directly (no temp table)
    const tableQuery = `SELECT * FROM ${firstTable.schema}.${firstTable.name}`;
    await conn.run(`
      CREATE OR REPLACE VIEW "${escapedViewNameWithTable}" AS
      ${tableQuery}
    `);

    // Verify the view was created successfully by trying to query it
    try {
      const verifyReader = await conn.runAndReadAll(
        `SELECT 1 FROM "${escapedViewNameWithTable}" LIMIT 1`,
      );
      await verifyReader.readAll();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to create or verify view "${viewNameWithTable}": ${errorMsg}`,
      );
    }

    // Extract schema from the created view using the same connection
    // Note: extractSchema will escape the viewName internally, so we pass the unescaped version
    const schema = await extractSchema({
      connection: conn,
      viewName: viewNameWithTable,
    });

    return {
      viewName: viewNameWithTable,
      displayName: viewNameWithTable,
      schema,
    };
  } finally {
    // Close driver if it has a close method
    if (driver.close) {
      await driver.close();
    }
  }
}
