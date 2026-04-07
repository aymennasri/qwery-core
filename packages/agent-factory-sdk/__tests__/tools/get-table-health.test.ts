import { describe, expect, it } from 'vitest';
import { buildTableHealthSql } from '../../src/tools/get-table-health';

describe('get_table_health SQL safety', () => {
  it('does not subtract infinity when maintenance timestamps are missing', () => {
    const sql = buildTableHealthSql(20);

    expect(sql).toContain(
      'WHEN stats.last_vacuum IS NOT NULL OR stats.last_autovacuum IS NOT NULL',
    );
    expect(sql).toContain(
      'WHEN stats.last_analyze IS NOT NULL OR stats.last_autoanalyze IS NOT NULL',
    );
    expect(sql).not.toContain('now() - COALESCE(');
  });
});
