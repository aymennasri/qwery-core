import { dropTable } from './view-registry';

export interface DeleteSheetOptions {
  conversationId: string;
  workspace: string;
  sheetNames: string[];
}

export interface DeleteSheetResult {
  deletedSheets: string[];
  failedSheets: Array<{ sheetName: string; error: string }>;
  message: string;
}

export const deleteSheet = async (
  opts: DeleteSheetOptions,
): Promise<DeleteSheetResult> => {
  const { conversationId, workspace, sheetNames } = opts;

  if (!sheetNames || sheetNames.length === 0) {
    throw new Error('At least one sheet name is required');
  }

  const deletedSheets: string[] = [];
  const failedSheets: Array<{ sheetName: string; error: string }> = [];

  const { join } = await import('node:path');
  const dbPath = join(workspace, conversationId, 'database.db');

  // Delete each sheet
  for (const sheetName of sheetNames) {
    try {
      await dropTable(dbPath, sheetName);
      deletedSheets.push(sheetName);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      failedSheets.push({ sheetName, error: errorMsg });
    }
  }

  const successCount = deletedSheets.length;
  const failCount = failedSheets.length;

  let message: string;
  if (successCount === sheetNames.length) {
    message = `Successfully deleted ${successCount} sheet(s): ${deletedSheets.join(', ')}`;
  } else if (successCount > 0) {
    message = `Deleted ${successCount} sheet(s): ${deletedSheets.join(', ')}. Failed to delete ${failCount} sheet(s): ${failedSheets.map((f) => f.sheetName).join(', ')}`;
  } else {
    message = `Failed to delete all ${failCount} sheet(s)`;
  }

  return {
    deletedSheets,
    failedSheets,
    message,
  };
};
