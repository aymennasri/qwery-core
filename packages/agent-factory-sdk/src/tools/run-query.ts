export interface RunQueryOptions {
  conversationId: string;
  workspace: string;
  query: string;
  checkedDatasourceIds?: string[]; // For syncing state
}

export interface RunQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

/**
 * Recursively converts BigInt values to numbers for JSON serialization
 */
const convertBigInt = (value: unknown): unknown => {
  if (typeof value === 'bigint') {
    // Convert BigInt to number if it's within safe integer range, otherwise to string
    if (value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER) {
      return Number(value);
    }
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(convertBigInt);
  }
  if (value && typeof value === 'object') {
    const converted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      converted[key] = convertBigInt(val);
    }
    return converted;
  }
  return value;
};

export const runQuery = async (
  opts: RunQueryOptions,
): Promise<RunQueryResult> => {
  const { DuckDBInstanceManager } = await import('./duckdb-instance-manager');
  const { conversationId, workspace, query } = opts;

  // Get connection from manager
  const conn = await DuckDBInstanceManager.getConnection(
    conversationId,
    workspace,
  );

  try {
    // Sync datasources if checkedDatasourceIds provided
    // Note: This requires datasourceRepository which we don't have here
    // For now, we'll sync in the caller (read-data-agent) before calling runQuery
    // TODO: Consider passing datasourceRepository to runQuery if needed

    // Execute the query
    const resultReader = await conn.runAndReadAll(query);
    await resultReader.readAll();
    const rows = resultReader.getRowObjectsJS() as Array<
      Record<string, unknown>
    >;
    const columnNames = resultReader.columnNames();

    // Convert BigInt values to numbers/strings for JSON serialization
    const convertedRows = rows.map(
      (row) => convertBigInt(row) as Record<string, unknown>,
    );

    return {
      columns: columnNames,
      rows: convertedRows,
    };
  } finally {
    // Return connection to pool instead of closing
    DuckDBInstanceManager.returnConnection(conversationId, workspace, conn);
  }
};
