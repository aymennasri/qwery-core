import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  unlinkSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  rmdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock CSV content
const mockCsvContent = `name,age,city
John Doe,30,New York
Jane Smith,25,San Francisco
Bob Johnson,35,Chicago`;

describe('gsheetToDuckdb', () => {
  let testWorkspace: string;
  const conversationId = 'test-conversation';
  let csvFilePath: string;

  beforeEach(() => {
    testWorkspace = join(
      tmpdir(),
      `test-workspace-${Date.now()}-${Math.random().toString(36).substring(7)}`,
    );
    csvFilePath = join(testWorkspace, 'test.csv');

    // Ensure directory exists
    mkdirSync(testWorkspace, { recursive: true });

    // Create a local CSV file for testing (since DuckDB uses its own HTTP client)
    writeFileSync(csvFilePath, mockCsvContent);
  });

  afterEach(async () => {
    // Clean up instance manager
    const { DuckDBInstanceManager } = await import(
      '../../src/tools/duckdb-instance-manager'
    );
    try {
      await DuckDBInstanceManager.closeInstance(conversationId, testWorkspace);
    } catch {
      // Ignore cleanup errors
    }

    // Clean up test database files
    try {
      const dbPath = join(testWorkspace, conversationId, 'database.db');
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
      if (existsSync(csvFilePath)) {
        unlinkSync(csvFilePath);
      }
      // Clean up workspace directory
      try {
        rmdirSync(join(testWorkspace, conversationId));
        rmdirSync(testWorkspace);
      } catch {
        // Ignore errors
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create DuckDB view from Google Sheet link', async () => {
    const { gsheetToDuckdb } = await import('../../src/tools/gsheet-to-duckdb');
    const { DuckDBInstanceManager } = await import(
      '../../src/tools/duckdb-instance-manager'
    );
    // Use local CSV file path instead of URL for testing
    const sharedLink = csvFilePath;
    const viewName = 'test_sheet';

    const conn = await DuckDBInstanceManager.getConnection(
      conversationId,
      testWorkspace,
    );
    try {
      const result = await gsheetToDuckdb({
        connection: conn,
        sharedLink,
        viewName,
      });

      expect(result).toContain(`Successfully created view '${viewName}'`);

      // Verify view exists by querying it
      const resultReader = await conn.runAndReadAll(
        `SELECT * FROM "${viewName}" LIMIT 1`,
      );
      await resultReader.readAll();
      const rows = resultReader.getRowObjectsJS();
      expect(rows.length).toBeGreaterThan(0);
      // Verify CSV data was loaded
      expect(rows[0]).toHaveProperty('name');
      expect(rows[0]).toHaveProperty('age');
      expect(rows[0]).toHaveProperty('city');
    } finally {
      DuckDBInstanceManager.returnConnection(
        conversationId,
        testWorkspace,
        conn,
      );
    }
  });

  it('should handle non-Google Sheets links', async () => {
    const { gsheetToDuckdb } = await import('../../src/tools/gsheet-to-duckdb');
    const { DuckDBInstanceManager } = await import(
      '../../src/tools/duckdb-instance-manager'
    );
    // Use local CSV file path
    const sharedLink = csvFilePath;
    const viewName = 'test_sheet';

    const conn = await DuckDBInstanceManager.getConnection(
      conversationId,
      testWorkspace,
    );
    try {
      const result = await gsheetToDuckdb({
        connection: conn,
        sharedLink,
        viewName,
      });

      expect(result).toContain(`Successfully created view '${viewName}'`);
    } finally {
      DuckDBInstanceManager.returnConnection(
        conversationId,
        testWorkspace,
        conn,
      );
    }
  });

  it('should create directories if they do not exist', async () => {
    const { gsheetToDuckdb } = await import('../../src/tools/gsheet-to-duckdb');
    const { DuckDBInstanceManager } = await import(
      '../../src/tools/duckdb-instance-manager'
    );
    const newConversationId = 'new-conversation';
    const newDbPath = join(testWorkspace, newConversationId, 'database.db');
    const viewName = 'test_sheet';

    const conn = await DuckDBInstanceManager.getConnection(
      newConversationId,
      testWorkspace,
    );
    try {
      await gsheetToDuckdb({
        connection: conn,
        sharedLink: csvFilePath,
        viewName,
      });

      expect(existsSync(newDbPath)).toBe(true);
    } finally {
      DuckDBInstanceManager.returnConnection(
        newConversationId,
        testWorkspace,
        conn,
      );
      await DuckDBInstanceManager.closeInstance(
        newConversationId,
        testWorkspace,
      );
    }

    // Cleanup
    try {
      unlinkSync(newDbPath);
      rmdirSync(join(testWorkspace, newConversationId));
    } catch {
      // Ignore cleanup errors
    }
  });
});
