import { z } from 'zod';

import {
  getErrorMessage,
  isPostgresDatasource,
  toNumber,
  toSafeLimit,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';
import { Tool } from './tool';

const DESCRIPTION =
  'Collect top slow query candidates using hybrid PostgreSQL sources. Returns mean/total execution time, stddev (P95 proxy), rows-per-call, planning-time ratio, and pg_stat_statements reset-time caveat when applicable.';

export const READ_WORKLOAD_REGEX = '^(SELECT|WITH)([[:space:]]|$)';

type QuerySummary = {
  queryId: string;
  query: string;
  calls: number;
  totalExecTimeMs: number;
  meanExecTimeMs: number;
  stddevExecTimeMs: number | null;
  minExecTimeMs: number | null;
  maxExecTimeMs: number | null;
  meanPlanTimeMs: number | null;
  totalPlanTimeMs: number | null;
  planExecRatio: number | null;
  rows: number;
  rowsPerCall: number | null;
  sharedBlksHit: number | null;
  sharedBlksRead: number | null;
  localBlksDirtied: number | null;
  tempBlksWritten: number | null;
};

export function buildPgStatStatementsSql(
  limit: number,
  useLegacyTimingColumns: boolean,
): string {
  const totalTimeCol = useLegacyTimingColumns
    ? 'total_time'
    : 'total_exec_time';
  const meanTimeCol = useLegacyTimingColumns ? 'mean_time' : 'mean_exec_time';
  // stddev, min, max, plan columns do not exist in legacy schema — emit NULLs
  const stddevCol = useLegacyTimingColumns ? 'NULL' : 'stddev_exec_time';
  const minExecCol = useLegacyTimingColumns ? 'NULL' : 'min_exec_time';
  const maxExecCol = useLegacyTimingColumns ? 'NULL' : 'max_exec_time';
  const meanPlanCol = useLegacyTimingColumns ? 'NULL' : 'mean_plan_time';
  const totalPlanCol = useLegacyTimingColumns ? 'NULL' : 'total_plan_time';
  // Block-level IO columns exist in both schema versions
  const sharedBlksHitCol = 'shared_blks_hit';
  const sharedBlksReadCol = 'shared_blks_read';
  const localBlksDirtiedCol = 'local_blks_dirtied';
  const tempBlksWrittenCol = 'temp_blks_written';

  return `
    SELECT
      COALESCE(queryid::text, 'unknown')                                  AS query_id,
      LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 4000)                 AS query_text,
      calls,
      ${totalTimeCol}                                                      AS total_exec_time_ms,
      ${meanTimeCol}                                                       AS mean_exec_time_ms,
      ${stddevCol}::double precision                                       AS stddev_exec_time_ms,
      ${minExecCol}::double precision                                      AS min_exec_time_ms,
      ${maxExecCol}::double precision                                      AS max_exec_time_ms,
      ${meanPlanCol}::double precision                                     AS mean_plan_time_ms,
      ${totalPlanCol}::double precision                                    AS total_plan_time_ms,
      CASE
        WHEN calls > 0 AND ${meanTimeCol} > 0
        THEN ROUND(
          (((${meanPlanCol} / NULLIF(${meanTimeCol}, 0)) * 100)::numeric),
          2
        )
        ELSE NULL
      END                                                                  AS plan_exec_ratio_pct,
      rows,
      CASE
        WHEN calls > 0 THEN ROUND((rows::numeric / calls), 2)
        ELSE NULL
      END                                                                  AS rows_per_call,
      ${sharedBlksHitCol},
      ${sharedBlksReadCol},
      ${localBlksDirtiedCol},
      ${tempBlksWrittenCol}
    FROM pg_stat_statements
    WHERE query IS NOT NULL
      AND query <> ''
      AND query NOT ILIKE '%pg_stat_statements%'
      AND query NOT ILIKE '%pg_stat_%'
      AND query NOT ILIKE '%pg_settings%'
      AND regexp_replace(query, '^[[:space:]]+', '', 'g') ~* '${READ_WORKLOAD_REGEX}'
      AND query NOT ILIKE '%information_schema.%'
      AND query NOT ILIKE '%pg_catalog.%'
    ORDER BY total_exec_time_ms DESC, mean_exec_time_ms DESC
    LIMIT ${limit}
  `;
}

async function queryPgStatStatements(
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  limit: number,
): Promise<{ queries: QuerySummary[]; sourceNotes: string[] }> {
  const attempts: Array<{ useLegacyTimingColumns: boolean; label: string }> = [
    {
      useLegacyTimingColumns: false,
      label: 'default timing columns (total_exec_time, mean_exec_time)',
    },
    {
      useLegacyTimingColumns: true,
      label: 'legacy timing columns (total_time, mean_time)',
    },
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const result = await query(
        buildPgStatStatementsSql(limit, attempt.useLegacyTimingColumns),
      );

      const sourceNotes = attempt.useLegacyTimingColumns
        ? [
            'Using legacy pg_stat_statements timing columns (total_time/mean_time). stddev, min, max, and plan-time columns are unavailable in this schema version.',
          ]
        : [];

      return {
        queries: result.rows.map((row) => toQuerySummary(row)),
        sourceNotes,
      };
    } catch (error) {
      errors.push(`${attempt.label}: ${getErrorMessage(error)}`);
    }
  }

  throw new Error(`pg_stat_statements query failed (${errors.join(' | ')})`);
}

function toQuerySummary(row: Record<string, unknown>): QuerySummary {
  const calls = toNumber(row['calls']) ?? 0;
  const meanExecTimeMs = toNumber(row['mean_exec_time_ms']) ?? 0;
  const meanPlanTimeMs = toNumber(row['mean_plan_time_ms']) ?? null;

  // Derive plan/exec ratio if the column came back NULL (legacy schema)
  const rawPlanExecRatio = toNumber(row['plan_exec_ratio_pct']);
  const derivedPlanExecRatio =
    rawPlanExecRatio !== null
      ? rawPlanExecRatio
      : meanPlanTimeMs !== null && meanExecTimeMs > 0
        ? Number(((meanPlanTimeMs / meanExecTimeMs) * 100).toFixed(2))
        : null;

  return {
    queryId: toString(row['query_id']) ?? 'unknown',
    query: toString(row['query_text']) ?? '',
    calls,
    totalExecTimeMs: toNumber(row['total_exec_time_ms']) ?? 0,
    meanExecTimeMs,
    stddevExecTimeMs: toNumber(row['stddev_exec_time_ms']) ?? null,
    minExecTimeMs: toNumber(row['min_exec_time_ms']) ?? null,
    maxExecTimeMs: toNumber(row['max_exec_time_ms']) ?? null,
    meanPlanTimeMs,
    totalPlanTimeMs: toNumber(row['total_plan_time_ms']) ?? null,
    planExecRatio: derivedPlanExecRatio,
    rows: toNumber(row['rows']) ?? 0,
    rowsPerCall: toNumber(row['rows_per_call']) ?? null,
    sharedBlksHit: toNumber(row['shared_blks_hit']) ?? null,
    sharedBlksRead: toNumber(row['shared_blks_read']) ?? null,
    localBlksDirtied: toNumber(row['local_blks_dirtied']) ?? null,
    tempBlksWritten: toNumber(row['temp_blks_written']) ?? null,
  };
}

async function getPgssResetCaveat(
  query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>,
  sourceNotes: string[],
): Promise<void> {
  try {
    const result = await query(`
      SELECT
        stats_reset::text                                                   AS stats_reset,
        EXTRACT(EPOCH FROM (now() - stats_reset))::double precision         AS seconds_since_reset
      FROM pg_stat_statements_info
    `);
    const row = result.rows[0];
    if (!row) return;

    const secondsSinceReset = toNumber(row['seconds_since_reset']);
    const statsReset = toString(row['stats_reset']);

    if (secondsSinceReset !== null && secondsSinceReset < 3600) {
      sourceNotes.push(
        `pg_stat_statements was reset ${Math.round(secondsSinceReset / 60)} minute(s) ago (at ${statsReset ?? 'unknown'}) — cumulative metrics cover a very short window and may not represent typical workload patterns.`,
      );
    } else if (statsReset) {
      sourceNotes.push(
        `pg_stat_statements data accumulated since last reset at ${statsReset}.`,
      );
    }
  } catch {
    // pg_stat_statements_info is available only in PG14+ — silently skip
  }
}

export const GetTopSlowQueriesTool = Tool.define('get_top_slow_queries', {
  description: DESCRIPTION,
  parameters: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe(
        'Maximum number of slow-query candidates to return (default: 10).',
      ),
  }),
  async execute(params, ctx) {
    const limit = toSafeLimit(params.limit, 10, 50);

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `This tool currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const sourceNotes: string[] = [];

      let pgStatStatementsEnabled = false;
      try {
        const extensionResult = await query(
          "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements') AS enabled",
        );
        const enabled = extensionResult.rows[0]?.['enabled'];
        pgStatStatementsEnabled =
          enabled === true || enabled === 't' || enabled === 1;
      } catch {
        pgStatStatementsEnabled = false;
      }

      if (pgStatStatementsEnabled) {
        // Check reset time before fetching data so the caveat is always first
        await getPgssResetCaveat(query, sourceNotes);

        try {
          const pgStatStatementsResult = await queryPgStatStatements(
            query,
            limit,
          );
          sourceNotes.push(...pgStatStatementsResult.sourceNotes);

          if (pgStatStatementsResult.queries.length > 0) {
            // Surface any high-variance or high-planning-ratio queries as hints
            const flagged: string[] = [];
            for (const q of pgStatStatementsResult.queries) {
              if (
                q.stddevExecTimeMs !== null &&
                q.meanExecTimeMs > 0 &&
                q.stddevExecTimeMs / q.meanExecTimeMs > 2
              ) {
                flagged.push(
                  `Query ${q.queryId} has high execution-time variance (stddev ${q.stddevExecTimeMs.toFixed(2)} ms vs mean ${q.meanExecTimeMs.toFixed(2)} ms — possible P95 outlier).`,
                );
              }
              if (
                q.planExecRatio !== null &&
                q.planExecRatio > 50 &&
                q.meanExecTimeMs > 10
              ) {
                flagged.push(
                  `Query ${q.queryId} spends ${q.planExecRatio.toFixed(1)}% of its runtime in planning — possible generic plan or missing prepared-statement usage.`,
                );
              }
            }
            if (flagged.length > 0) {
              sourceNotes.push(...flagged);
            }

            return {
              source: 'pg_stat_statements',
              limit,
              queries: pgStatStatementsResult.queries,
              sourceNotes,
            };
          }

          sourceNotes.push(
            'pg_stat_statements returned no qualifying SELECT/WITH queries; falling back to active sessions.',
          );
        } catch (error) {
          sourceNotes.push(
            `pg_stat_statements query failed; falling back to pg_stat_activity (${getErrorMessage(error)}).`,
          );
        }
      } else {
        sourceNotes.push(
          'pg_stat_statements extension is not enabled; using active-session snapshot from pg_stat_activity. Enable pg_stat_statements for reliable workload profiling.',
        );
      }

      // ------------------------------------------------------------------
      // Fallback: snapshot of currently active queries from pg_stat_activity.
      // This captures only queries running at this moment — treat as a point-
      // in-time observation, not a workload profile.
      // ------------------------------------------------------------------
      sourceNotes.push(
        'pg_stat_activity fallback: results reflect a single point-in-time snapshot. stddev, min, max, plan time, and block-level IO are unavailable in this mode.',
      );

      const fallback = await query(`
        SELECT
          pid::text                                                             AS query_id,
          LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 4000)                  AS query_text,
          1::bigint                                                             AS calls,
          (EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)
            ::double precision                                                  AS total_exec_time_ms,
          (EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) * 1000)
            ::double precision                                                  AS mean_exec_time_ms,
          NULL::double precision                                                AS stddev_exec_time_ms,
          NULL::double precision                                                AS min_exec_time_ms,
          NULL::double precision                                                AS max_exec_time_ms,
          NULL::double precision                                                AS mean_plan_time_ms,
          NULL::double precision                                                AS total_plan_time_ms,
          NULL::numeric                                                         AS plan_exec_ratio_pct,
          0::bigint                                                             AS rows,
          NULL::numeric                                                         AS rows_per_call,
          NULL::bigint                                                          AS shared_blks_hit,
          NULL::bigint                                                          AS shared_blks_read,
          NULL::bigint                                                          AS local_blks_dirtied,
          NULL::bigint                                                          AS temp_blks_written
        FROM pg_stat_activity
        WHERE state = 'active'
          AND query_start IS NOT NULL
          AND pid <> pg_backend_pid()
          AND query NOT ILIKE '%pg_stat_activity%'
          AND query NOT ILIKE '%pg_stat_%'
          AND query NOT ILIKE '%pg_settings%'
          AND query NOT ILIKE '%pg_catalog%'
          AND query NOT ILIKE '%information_schema.%'
          AND regexp_replace(query, '^[[:space:]]+', '', 'g') ~* '${READ_WORKLOAD_REGEX}'
        ORDER BY total_exec_time_ms DESC
        LIMIT ${limit}
      `);

      return {
        source: 'pg_stat_activity',
        limit,
        queries: fallback.rows.map((row) => toQuerySummary(row)),
        sourceNotes,
      };
    });
  },
});
