import { DuckDBInstanceManager } from './duckdb-instance-manager';
import { renameView } from './view-registry';

export interface RenameSheetOptions {
  conversationId: string;
  workspace: string;
  oldSheetName: string;
  newSheetName: string;
}

export interface RenameSheetResult {
  oldSheetName: string;
  newSheetName: string;
  message: string;
}

export const renameSheet = async (
  opts: RenameSheetOptions,
): Promise<RenameSheetResult> => {
  const { conversationId, workspace, oldSheetName, newSheetName } = opts;

  // Validate inputs
  if (!oldSheetName || !newSheetName) {
    throw new Error('Both oldSheetName and newSheetName are required');
  }

  if (oldSheetName === newSheetName) {
    throw new Error('Old and new sheet names cannot be the same');
  }

  const conn = await DuckDBInstanceManager.getConnection(
    conversationId,
    workspace,
  );

  try {
    const escapedOldName = oldSheetName.replace(/"/g, '""');
    const escapedNewName = newSheetName.replace(/"/g, '""');

    // Check if old view exists
    try {
      await conn.run(`SELECT 1 FROM "${escapedOldName}" LIMIT 1`);
    } catch {
      throw new Error(`View "${oldSheetName}" does not exist. Cannot rename.`);
    }

    // Check if new name already exists
    try {
      await conn.run(`SELECT 1 FROM "${escapedNewName}" LIMIT 1`);
      throw new Error(
        `View "${newSheetName}" already exists. Cannot rename to an existing name.`,
      );
    } catch (error) {
      // If error is about table not found, that's good - name is available
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (
        !errorMsg.includes('does not exist') &&
        !errorMsg.includes('not found') &&
        !errorMsg.includes('Catalog Error')
      ) {
        // Some other error occurred, rethrow
        throw error;
      }
    }

    // Rename the view using view-registry function (which updates viewRegistry)
    const { join } = await import('node:path');
    const dbPath = join(workspace, conversationId, 'database.db');
    await renameView(dbPath, oldSheetName, newSheetName);

    return {
      oldSheetName,
      newSheetName,
      message: `Successfully renamed view "${oldSheetName}" to "${newSheetName}"`,
    };
  } finally {
    DuckDBInstanceManager.returnConnection(conversationId, workspace, conn);
  }
};
