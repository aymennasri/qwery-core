import { describe, expect, it } from 'vitest';
import {
  buildPgStatStatementsSql,
  READ_WORKLOAD_REGEX,
} from '../../src/tools/get-top-slow-queries';

describe('get_top_slow_queries SQL filters', () => {
  it('uses a PostgreSQL-compatible read-query prefix regex', () => {
    expect(READ_WORKLOAD_REGEX).toBe('^(SELECT|WITH)([[:space:]]|$)');
    expect(READ_WORKLOAD_REGEX.includes('\\b')).toBe(false);
  });

  it('builds pg_stat_statements SQL with read-query filter and noise exclusions', () => {
    const sql = buildPgStatStatementsSql(10, false);

    expect(sql).toContain(
      "regexp_replace(query, '^[[:space:]]+', '', 'g') ~* '^(SELECT|WITH)([[:space:]]|$)'",
    );
    expect(sql).toContain("query NOT ILIKE '%pg_stat_%'");
    expect(sql).toContain("query NOT ILIKE '%pg_settings%'");
  });
});
