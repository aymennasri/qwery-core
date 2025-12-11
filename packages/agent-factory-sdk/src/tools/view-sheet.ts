import { runQuery } from './run-query';

export interface ViewSheetOptions {
  conversationId: string;
  workspace: string;
  sheetName: string;
  limit?: number;
}

export interface ViewSheetResult {
  sheetName: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  limit: number;
  hasMore: boolean;
}

export const viewSheet = async (
  opts: ViewSheetOptions,
): Promise<ViewSheetResult> => {
  const { conversationId, workspace, sheetName, limit = 50 } = opts;

  if (!sheetName) {
    throw new Error('sheetName is required');
  }

  // Escape the sheet name for SQL
  const escapedSheetName = sheetName.replace(/"/g, '""');

  // Build query - handle both simple names and fully qualified paths
  let query: string;
  if (sheetName.includes('.')) {
    // Fully qualified path (e.g., ds_xxx.public.users)
    query = `SELECT * FROM "${escapedSheetName}" LIMIT ${limit}`;
  } else {
    // Simple name (view in main database)
    query = `SELECT * FROM "${escapedSheetName}" LIMIT ${limit}`;
  }

  // Execute query using runQuery (which uses centralized manager)
  const result = await runQuery({
    conversationId,
    workspace,
    query,
  });

  // Check if there are more rows (query with limit + 1)
  let hasMore = false;
  if (result.rows.length === limit) {
    // There might be more rows
    const countQuery = sheetName.includes('.')
      ? `SELECT COUNT(*) as count FROM "${escapedSheetName}"`
      : `SELECT COUNT(*) as count FROM "${escapedSheetName}"`;

    try {
      const countResult = await runQuery({
        conversationId,
        workspace,
        query: countQuery,
      });
      const totalCount =
        (countResult.rows[0]?.['count'] as number) || result.rows.length;
      hasMore = totalCount > limit;
    } catch {
      // If count query fails, assume there might be more
      hasMore = result.rows.length === limit;
    }
  }

  return {
    sheetName,
    columns: result.columns,
    rows: result.rows,
    rowCount: result.rows.length,
    limit,
    hasMore,
  };
};
