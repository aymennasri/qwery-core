import { z } from 'zod';

import {
  isPostgresDatasource,
  toNumber,
  toSafeLimit,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';
import { Tool } from './tool';

const DESCRIPTION =
  'Collect PostgreSQL table-health metrics: size, dead tuples, scan profile, maintenance counters, temporal vacuum/analyze timestamps, rows modified since last analyze, and per-table autovacuum overrides.';

export const GetTableHealthTool = Tool.define('get_table_health', {
  description: DESCRIPTION,
  parameters: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Maximum number of tables to inspect (default: 20).'),
  }),
  async execute(params, ctx) {
    const limit = toSafeLimit(params.limit, 20, 100);

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `db-performance-audit currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const result = await query(`
        SELECT
          stats.schemaname,
          stats.relname                                                           AS table_name,
          stats.n_live_tup,
          stats.n_dead_tup,
          CASE
            WHEN (stats.n_live_tup + stats.n_dead_tup) = 0 THEN 0
            ELSE ROUND(
              (stats.n_dead_tup::numeric / (stats.n_live_tup + stats.n_dead_tup)) * 100,
              2
            )
          END                                                                     AS dead_tuple_pct,
          stats.n_mod_since_analyze,
          CASE
            WHEN stats.n_live_tup > 0
            THEN ROUND((stats.n_mod_since_analyze::numeric / stats.n_live_tup) * 100, 2)
            ELSE 0
          END                                                                     AS mod_since_analyze_pct,
          pg_total_relation_size(stats.relid)                                     AS total_size_bytes,
          pg_relation_size(stats.relid)                                           AS heap_size_bytes,
          pg_total_relation_size(stats.relid)
            - pg_relation_size(stats.relid)                                       AS index_size_bytes,
          stats.seq_scan,
          stats.idx_scan,
          stats.seq_tup_read,
          stats.idx_tup_fetch,
          stats.n_tup_ins,
          stats.n_tup_upd,
          stats.n_tup_del,
          stats.n_tup_hot_upd,
          stats.vacuum_count,
          stats.autovacuum_count,
          stats.analyze_count,
          stats.autoanalyze_count,
          stats.last_vacuum,
          stats.last_autovacuum,
          stats.last_analyze,
          stats.last_autoanalyze,
          GREATEST(stats.last_vacuum, stats.last_autovacuum)                      AS most_recent_vacuum,
          GREATEST(stats.last_analyze, stats.last_autoanalyze)                    AS most_recent_analyze,
          EXTRACT(EPOCH FROM
            (now() - COALESCE(
              GREATEST(stats.last_vacuum, stats.last_autovacuum),
              '-infinity'::timestamptz
            ))
          )::double precision                                                      AS seconds_since_vacuum,
          EXTRACT(EPOCH FROM
            (now() - COALESCE(
              GREATEST(stats.last_analyze, stats.last_autoanalyze),
              '-infinity'::timestamptz
            ))
          )::double precision                                                      AS seconds_since_analyze,
          reloptions.autovacuum_enabled_override,
          reloptions.autovacuum_vacuum_scale_factor_override,
          reloptions.autovacuum_analyze_scale_factor_override,
          reloptions.autovacuum_vacuum_threshold_override,
          reloptions.autovacuum_analyze_threshold_override,
          reloptions.fillfactor_override
        FROM pg_stat_user_tables stats
        JOIN pg_class class_meta ON class_meta.oid = stats.relid
        LEFT JOIN LATERAL (
          SELECT
            MAX(CASE WHEN option_name = 'autovacuum_enabled'                THEN option_value END) AS autovacuum_enabled_override,
            MAX(CASE WHEN option_name = 'autovacuum_vacuum_scale_factor'    THEN option_value END) AS autovacuum_vacuum_scale_factor_override,
            MAX(CASE WHEN option_name = 'autovacuum_analyze_scale_factor'   THEN option_value END) AS autovacuum_analyze_scale_factor_override,
            MAX(CASE WHEN option_name = 'autovacuum_vacuum_threshold'       THEN option_value END) AS autovacuum_vacuum_threshold_override,
            MAX(CASE WHEN option_name = 'autovacuum_analyze_threshold'      THEN option_value END) AS autovacuum_analyze_threshold_override,
            MAX(CASE WHEN option_name = 'fillfactor'                        THEN option_value END) AS fillfactor_override
          FROM pg_options_to_table(class_meta.reloptions)
        ) reloptions ON TRUE
        ORDER BY pg_total_relation_size(stats.relid) DESC
        LIMIT ${limit}
      `);

      return {
        limit,
        tables: result.rows.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',

          // Tuple counts
          liveTuples: toNumber(row['n_live_tup']) ?? 0,
          deadTuples: toNumber(row['n_dead_tup']) ?? 0,
          deadTuplePct: toNumber(row['dead_tuple_pct']) ?? 0,

          // Stats freshness
          modSinceAnalyze: toNumber(row['n_mod_since_analyze']) ?? 0,
          modSinceAnalyzePct: toNumber(row['mod_since_analyze_pct']) ?? 0,

          // Sizes
          totalSizeBytes: toNumber(row['total_size_bytes']) ?? 0,
          heapSizeBytes: toNumber(row['heap_size_bytes']) ?? 0,
          indexSizeBytes: toNumber(row['index_size_bytes']) ?? 0,

          // Scan profile
          seqScan: toNumber(row['seq_scan']) ?? 0,
          idxScan: toNumber(row['idx_scan']) ?? 0,
          seqTupRead: toNumber(row['seq_tup_read']) ?? 0,
          idxTupFetch: toNumber(row['idx_tup_fetch']) ?? 0,

          // Write profile (churn indicators)
          tupInserted: toNumber(row['n_tup_ins']) ?? 0,
          tupUpdated: toNumber(row['n_tup_upd']) ?? 0,
          tupDeleted: toNumber(row['n_tup_del']) ?? 0,
          tupHotUpdated: toNumber(row['n_tup_hot_upd']) ?? 0,

          // Maintenance counters
          vacuumCount: toNumber(row['vacuum_count']) ?? 0,
          autovacuumCount: toNumber(row['autovacuum_count']) ?? 0,
          analyzeCount: toNumber(row['analyze_count']) ?? 0,
          autoanalyzeCount: toNumber(row['autoanalyze_count']) ?? 0,

          // Temporal maintenance timestamps
          lastVacuum: toString(row['last_vacuum']) ?? null,
          lastAutovacuum: toString(row['last_autovacuum']) ?? null,
          lastAnalyze: toString(row['last_analyze']) ?? null,
          lastAutoanalyze: toString(row['last_autoanalyze']) ?? null,
          mostRecentVacuum: toString(row['most_recent_vacuum']) ?? null,
          mostRecentAnalyze: toString(row['most_recent_analyze']) ?? null,
          secondsSinceVacuum: toNumber(row['seconds_since_vacuum']) ?? null,
          secondsSinceAnalyze: toNumber(row['seconds_since_analyze']) ?? null,

          // Per-table autovacuum configuration overrides
          autovacuumEnabledOverride:
            toString(row['autovacuum_enabled_override']) ?? null,
          autovacuumVacuumScaleFactorOverride:
            toString(row['autovacuum_vacuum_scale_factor_override']) ?? null,
          autovacuumAnalyzeScaleFactorOverride:
            toString(row['autovacuum_analyze_scale_factor_override']) ?? null,
          autovacuumVacuumThresholdOverride:
            toString(row['autovacuum_vacuum_threshold_override']) ?? null,
          autovacuumAnalyzeThresholdOverride:
            toString(row['autovacuum_analyze_threshold_override']) ?? null,
          fillfactorOverride: toString(row['fillfactor_override']) ?? null,
        })),
      };
    });
  },
});
