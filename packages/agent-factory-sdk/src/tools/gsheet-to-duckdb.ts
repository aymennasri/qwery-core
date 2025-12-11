import type { DuckDBInstance } from '@duckdb/node-api';

// Connection type from DuckDB instance
type Connection = Awaited<ReturnType<DuckDBInstance['connect']>>;

const convertToCsvLink = (message: string) => {
  const match = message.match(
    /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
  );
  if (!match) return message;
  const spreadsheetId = match[1];
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
};

export interface GSheetToDuckDbOptions {
  connection: Connection; // Changed from dbPath
  sharedLink: string;
  viewName: string;
}

export const gsheetToDuckdb = async (
  opts: GSheetToDuckDbOptions,
): Promise<string> => {
  const csvLink = convertToCsvLink(opts.sharedLink);
  const conn = opts.connection;

  const escapedUrl = csvLink.replace(/'/g, "''");
  const escapedViewName = opts.viewName.replace(/"/g, '""');

  // Create or replace view directly from the CSV URL
  await conn.run(`
    CREATE OR REPLACE VIEW "${escapedViewName}" AS
    SELECT * FROM read_csv_auto('${escapedUrl}')
  `);

  return `Successfully created view '${opts.viewName}' from Google Sheet`;
};
