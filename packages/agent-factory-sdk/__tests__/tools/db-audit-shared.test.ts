import { describe, expect, it } from 'vitest';
import {
  assertExplainTargetSql,
  assertReadOnlySql,
  toSafeLimit,
} from '../../src/tools/db-audit/shared';

describe('db-audit shared guards', () => {
  it('accepts read-only SQL statements', () => {
    expect(() => assertReadOnlySql('SELECT 1')).not.toThrow();
    expect(() =>
      assertReadOnlySql('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1'),
    ).not.toThrow();
    expect(() =>
      assertExplainTargetSql('WITH x AS (SELECT 1) SELECT * FROM x'),
    ).not.toThrow();
  });

  it('reports the calling tool for non-select explain targets', () => {
    expect(() =>
      assertExplainTargetSql('SET random_page_cost = 1.1', 'validate_remediation_in_gfs_cli'),
    ).toThrow(
      'validate_remediation_in_gfs_cli only accepts SELECT or WITH queries as input. Use actionStatements for SET/RESET or other write-capable SQL.',
    );
  });

  it('rejects write-capable SQL statements', () => {
    expect(() =>
      assertReadOnlySql('UPDATE users SET active = false'),
    ).toThrow();
    expect(() =>
      assertReadOnlySql('EXPLAIN ANALYZE UPDATE users SET active = false'),
    ).toThrow();
    expect(() => assertReadOnlySql('SELECT 1; SELECT 2')).toThrow();
  });

  it('allows read-only statements containing blocked keywords in string literals', () => {
    expect(() =>
      assertReadOnlySql(`
        SELECT regexp_replace(
          indexdef,
          '^CREATE\\s+UNIQUE\\s+INDEX\\s+[^ ]+\\s+ON\\s+',
          'ON '
        )
        FROM pg_indexes
      `),
    ).not.toThrow();
  });

  it('allows semicolons inside string literals', () => {
    expect(() =>
      assertReadOnlySql(
        "SELECT regexp_replace('a;b;c', ';', '-', 'g') AS normalized",
      ),
    ).not.toThrow();
  });

  it('normalizes limits safely', () => {
    expect(toSafeLimit(undefined, 10, 50)).toBe(10);
    expect(toSafeLimit(0, 10, 50)).toBe(10);
    expect(toSafeLimit(20, 10, 50)).toBe(20);
    expect(toSafeLimit(999, 10, 50)).toBe(50);
  });
});
