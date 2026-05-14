import { z } from 'zod';
import { Tool } from './tool';
import {
  getErrorMessage,
  isPostgresDatasource,
  toNumber,
  toSafeLimit,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';

const DESCRIPTION =
  'Assess PostgreSQL statistics freshness: tables with stale or missing stats, high-modification tables whose stats are out of date, and columns with suspect n_distinct values that can cause cardinality misestimation.';

export const GetStatisticsHealthTool = Tool.define('get_statistics_health', {
  description: DESCRIPTION,
  parameters: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum rows per result section (default: 20).'),
    staleThresholdHours: z
      .number()
      .int()
      .positive()
      .max(720)
      .optional()
      .describe(
        'Consider stats stale when last analyze is older than this many hours (default: 24).',
      ),
    minLiveTuples: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Minimum live tuple count for a table to appear in stale-stats results (default: 1000).',
      ),
  }),
  async execute(params, ctx) {
    const limit = toSafeLimit(params.limit, 20, 50);
    const staleThresholdHours = toSafeLimit(
      params.staleThresholdHours,
      24,
      720,
    );
    const minLiveTuples = toSafeLimit(params.minLiveTuples, 1000, 100_000_000);

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `This tool currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const sourceNotes: string[] = [];

      const queryRowsOrEmpty = async (
        sql: string,
        label: string,
      ): Promise<Array<Record<string, unknown>>> => {
        try {
          const result = await query(sql);
          return result.rows;
        } catch (error) {
          sourceNotes.push(`${label} (${getErrorMessage(error)}).`);
          return [];
        }
      };

      const queryOneOrEmpty = async (
        sql: string,
        label: string,
      ): Promise<Record<string, unknown>> => {
        const rows = await queryRowsOrEmpty(sql, label);
        return rows[0] ?? {};
      };

      // ------------------------------------------------------------------
      // 1. Tables with stale or missing statistics
      //    Ordered by n_mod_since_analyze DESC so the most out-of-date
      //    tables (highest change volume since last stats collection) come
      //    first.  We also include seconds_since_analyze so the agent can
      //    report both "how long ago" and "how much has changed".
      // ------------------------------------------------------------------
      const staleTableRows = await queryRowsOrEmpty(
        `
        SELECT
          schemaname,
          relname                                                          AS table_name,
          n_live_tup,
          n_dead_tup,
          n_mod_since_analyze,
          CASE
            WHEN n_live_tup > 0
            THEN ROUND((n_mod_since_analyze::numeric / n_live_tup) * 100, 2)
            ELSE 0
          END                                                              AS mod_ratio_pct,
          last_analyze,
          last_autoanalyze,
          GREATEST(last_analyze, last_autoanalyze)                         AS most_recent_analyze,
          EXTRACT(EPOCH FROM
            (now() - COALESCE(GREATEST(last_analyze, last_autoanalyze),
                               '-infinity'::timestamptz))
          )::double precision                                              AS seconds_since_analyze,
          seq_scan,
          idx_scan,
          analyze_count,
          autoanalyze_count
        FROM pg_stat_user_tables
        WHERE n_live_tup >= ${minLiveTuples}
          AND (
            GREATEST(last_analyze, last_autoanalyze) IS NULL
            OR GREATEST(last_analyze, last_autoanalyze)
                 < now() - interval '${staleThresholdHours} hours'
            OR n_mod_since_analyze > GREATEST(n_live_tup / 10, 1000)
          )
        ORDER BY n_mod_since_analyze DESC, seconds_since_analyze DESC NULLS FIRST
        LIMIT ${limit}
      `,
        'Unable to collect stale table statistics from pg_stat_user_tables',
      );

      // ------------------------------------------------------------------
      // 2. Tables that have never been analyzed at all
      // ------------------------------------------------------------------
      const neverAnalyzedRows = await queryRowsOrEmpty(
        `
        SELECT
          schemaname,
          relname   AS table_name,
          n_live_tup,
          n_dead_tup,
          seq_scan,
          idx_scan
        FROM pg_stat_user_tables
        WHERE last_analyze     IS NULL
          AND last_autoanalyze IS NULL
          AND n_live_tup > 0
        ORDER BY n_live_tup DESC
        LIMIT ${limit}
      `,
        'Unable to collect never-analyzed tables from pg_stat_user_tables',
      );

      // ------------------------------------------------------------------
      // 3. Columns with suspect n_distinct values
      //    n_distinct in (-0.5, 0.5) means PostgreSQL estimated very low
      //    cardinality.  When paired with low physical correlation this
      //    often causes severe row-count misestimates on range/join predicates.
      //    We cross-join with pg_stat_user_tables to surface only tables
      //    that are large enough to matter.
      // ------------------------------------------------------------------
      const columnStatsRows = await queryRowsOrEmpty(
        `
        SELECT
          s.schemaname,
          s.tablename                               AS table_name,
          s.attname                                 AS column_name,
          s.n_distinct,
          s.correlation,
          s.null_frac,
          s.avg_width,
          s.most_common_vals::text                  AS most_common_vals_sample,
          t.n_live_tup
        FROM pg_stats s
        JOIN pg_stat_user_tables t
          ON  t.schemaname = s.schemaname
          AND t.relname    = s.tablename
        WHERE t.n_live_tup > ${minLiveTuples}
          AND (
            -- extremely low estimated distinct count on a large table
            (s.n_distinct >= 0 AND s.n_distinct < 10 AND t.n_live_tup > 100000)
            -- fraction-based n_distinct close to -1 means almost every value
            -- is unique; combined with low physical correlation this is a
            -- classic cardinality-skew setup
            OR (s.n_distinct < 0 AND s.n_distinct > -0.05 AND ABS(COALESCE(s.correlation, 0)) < 0.1)
            -- near-zero fraction of rows are NULL but n_distinct says almost
            -- nothing varies — strongly suspect for join columns
            OR (s.null_frac < 0.01 AND s.n_distinct >= 0 AND s.n_distinct < 5 AND t.n_live_tup > 50000)
          )
        ORDER BY t.n_live_tup DESC
        LIMIT ${limit}
      `,
        'Unable to collect suspect column statistics from pg_stats',
      );

      // ------------------------------------------------------------------
      // 4. pg_stat_statements reset time — if stats were reset recently
      //    all cumulative workload data is suspect
      // ------------------------------------------------------------------
      const pgssInfoRow = await queryOneOrEmpty(
        `
        SELECT
          stats_reset::text  AS stats_reset,
          EXTRACT(EPOCH FROM (now() - stats_reset))::double precision
                             AS seconds_since_reset
        FROM pg_stat_statements_info
      `,
        'Unable to read pg_stat_statements_info (extension may not be loaded)',
      );

      const secondsSinceReset = toNumber(pgssInfoRow['seconds_since_reset']);
      if (secondsSinceReset !== null && secondsSinceReset < 3600) {
        sourceNotes.push(
          `pg_stat_statements was reset ${Math.round(secondsSinceReset / 60)} minute(s) ago — cumulative workload metrics cover a very short window and may not be representative.`,
        );
      }

      // ------------------------------------------------------------------
      // 5. autovacuum_analyze settings summary (tables where autovacuum
      //    analyze has been explicitly throttled or disabled)
      // ------------------------------------------------------------------
      const autovacuumOverrideRows = await queryRowsOrEmpty(
        `
        SELECT
          n.nspname                        AS schemaname,
          c.relname                        AS table_name,
          unnest(c.reloptions)             AS option
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'r'
          AND c.reloptions IS NOT NULL
          AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          AND EXISTS (
            SELECT 1
            FROM unnest(c.reloptions) opt
            WHERE opt ILIKE 'autovacuum_enabled%'
               OR opt ILIKE 'autovacuum_analyze_scale_factor%'
               OR opt ILIKE 'autovacuum_analyze_threshold%'
          )
        ORDER BY n.nspname, c.relname
        LIMIT ${limit}
      `,
        'Unable to collect per-table autovacuum analyze overrides',
      );

      return {
        staleThresholdHours,
        minLiveTuples,
        pgStatStatementsResetAt: toString(pgssInfoRow['stats_reset']) ?? null,
        secondsSincePgssReset: secondsSinceReset,
        staleTableStats: staleTableRows.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          liveTuples: toNumber(row['n_live_tup']) ?? 0,
          deadTuples: toNumber(row['n_dead_tup']) ?? 0,
          modSinceAnalyze: toNumber(row['n_mod_since_analyze']) ?? 0,
          modRatioPct: toNumber(row['mod_ratio_pct']) ?? 0,
          lastAnalyze: toString(row['last_analyze']) ?? null,
          lastAutoanalyze: toString(row['last_autoanalyze']) ?? null,
          mostRecentAnalyze: toString(row['most_recent_analyze']) ?? null,
          secondsSinceAnalyze: toNumber(row['seconds_since_analyze']) ?? null,
          seqScan: toNumber(row['seq_scan']) ?? 0,
          idxScan: toNumber(row['idx_scan']) ?? 0,
          analyzeCount: toNumber(row['analyze_count']) ?? 0,
          autoanalyzeCount: toNumber(row['autoanalyze_count']) ?? 0,
        })),
        neverAnalyzedTables: neverAnalyzedRows.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          liveTuples: toNumber(row['n_live_tup']) ?? 0,
          deadTuples: toNumber(row['n_dead_tup']) ?? 0,
          seqScan: toNumber(row['seq_scan']) ?? 0,
          idxScan: toNumber(row['idx_scan']) ?? 0,
        })),
        suspectColumnStats: columnStatsRows.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          column: toString(row['column_name']) ?? 'unknown',
          nDistinct: toNumber(row['n_distinct']) ?? 0,
          correlation: toNumber(row['correlation']) ?? null,
          nullFrac: toNumber(row['null_frac']) ?? 0,
          avgWidth: toNumber(row['avg_width']) ?? 0,
          mostCommonValsSample:
            toString(row['most_common_vals_sample']) ?? null,
          liveTuples: toNumber(row['n_live_tup']) ?? 0,
        })),
        autovacuumAnalyzeOverrides: autovacuumOverrideRows.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          option: toString(row['option']) ?? 'unknown',
        })),
        sourceNotes,
      };
    });
  },
});
