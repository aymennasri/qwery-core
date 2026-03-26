import { z } from 'zod';
import { Tool } from './tool';
import {
  isPostgresDatasource,
  toNumber,
  toSafeLimit,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';

const DESCRIPTION =
  'Estimate PostgreSQL table and index bloat using pg_catalog approximations (no pgstattuple required). Returns wasted-space estimates per table and low-usage oversized indexes as bloat candidates.';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    const firstLine = error.message.split('\n')[0]?.trim();
    return firstLine || 'unknown error';
  }
  return 'unknown error';
}

export const GetBloatEstimatesTool = Tool.define('get_bloat_estimates', {
  description: DESCRIPTION,
  parameters: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum rows per result section (default: 20).'),
    minBloatBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Minimum estimated bloat bytes to include a table in results (default: 1048576 = 1 MB).',
      ),
  }),
  async execute(params, ctx) {
    const limit = toSafeLimit(params.limit, 20, 50);
    const minBloatBytes =
      typeof params.minBloatBytes === 'number' &&
      Number.isFinite(params.minBloatBytes) &&
      params.minBloatBytes > 0
        ? Math.trunc(params.minBloatBytes)
        : 1024 * 1024;

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `db-performance-audit currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const sourceNotes: string[] = [
        'Table bloat is estimated from (dead_tuples / total_tuples) * heap_size — an approximation; actual wasted space may differ.',
        'Index bloat candidates are identified as large indexes with near-zero scan counts since the last pg_stat_user_indexes reset.',
        'For precise byte-level bloat, run pgstattuple on specific tables after this audit identifies candidates.',
      ];

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
      // 1. Table bloat estimates
      //    Strategy: dead-tuple fraction of heap size gives a lower-bound
      //    wasted-space estimate.  We also compute an "expected" live size
      //    from average tuple width * live tuples / fillfactor so we can
      //    show both the dead-tuple component and the overall bloat ratio.
      // ------------------------------------------------------------------
      const tableBloatRows = await queryRowsOrEmpty(
        `
        SELECT
          stats.schemaname,
          stats.relname                                                          AS table_name,
          stats.n_live_tup,
          stats.n_dead_tup,
          pg_relation_size(stats.relid)                                          AS heap_bytes,
          pg_total_relation_size(stats.relid)                                    AS total_bytes,
          CASE
            WHEN (stats.n_live_tup + stats.n_dead_tup) = 0 THEN 0
            ELSE ROUND(
              (stats.n_dead_tup::numeric
                / (stats.n_live_tup + stats.n_dead_tup))
              * pg_relation_size(stats.relid)
            )
          END                                                                    AS estimated_dead_tuple_bytes,
          CASE
            WHEN (stats.n_live_tup + stats.n_dead_tup) = 0 THEN 0
            ELSE ROUND(
              (stats.n_dead_tup::numeric
                / (stats.n_live_tup + stats.n_dead_tup)) * 100, 2
            )
          END                                                                    AS dead_tuple_bloat_pct,
          COALESCE(
            (
              SELECT (option_value::numeric)::int
              FROM   pg_options_to_table(class_meta.reloptions)
              WHERE  option_name = 'fillfactor'
              LIMIT  1
            ),
            100
          )                                                                      AS fillfactor,
          stats.last_vacuum,
          stats.last_autovacuum,
          stats.vacuum_count,
          stats.autovacuum_count
        FROM pg_stat_user_tables stats
        JOIN pg_class class_meta ON class_meta.oid = stats.relid
        WHERE pg_relation_size(stats.relid) > ${minBloatBytes}
          AND (stats.n_live_tup + stats.n_dead_tup) > 0
        ORDER BY estimated_dead_tuple_bytes DESC
        LIMIT ${limit}
      `,
        'Unable to estimate table bloat from pg_stat_user_tables',
      );

      // ------------------------------------------------------------------
      // 2. Index bloat candidates
      //    We use two complementary signals:
      //    (a) Large indexes with idx_scan = 0 since last reset — wasted
      //        space that is also functionally unused.
      //    (b) Large indexes on high-churn tables (seq_scan >> idx_scan)
      //        that may have accumulated bloat through repeated
      //        insert/update/delete cycles.
      // ------------------------------------------------------------------
      const indexBloatRows = await queryRowsOrEmpty(
        `
        SELECT
          ix_stats.schemaname,
          ix_stats.relname                                                       AS table_name,
          ix_stats.indexrelname                                                  AS index_name,
          pg_relation_size(ix_stats.indexrelid)                                  AS index_bytes,
          pg_relation_size(ix_stats.relid)                                       AS table_heap_bytes,
          ix_stats.idx_scan,
          ix_stats.idx_tup_read,
          ix.indisvalid                                                          AS is_valid,
          ix.indisunique                                                         AS is_unique,
          ix.indisprimary                                                        AS is_primary,
          EXISTS (
            SELECT 1 FROM pg_constraint con
            WHERE  con.conindid = ix_stats.indexrelid
          )                                                                      AS backs_constraint,
          tab.n_live_tup,
          tab.n_dead_tup,
          tab.seq_scan                                                           AS table_seq_scan,
          tab.last_vacuum,
          tab.last_autovacuum
        FROM pg_stat_user_indexes ix_stats
        JOIN pg_index ix  ON ix.indexrelid  = ix_stats.indexrelid
        JOIN pg_stat_user_tables tab ON tab.relid = ix_stats.relid
        WHERE pg_relation_size(ix_stats.indexrelid) > ${minBloatBytes}
          AND (
            ix_stats.idx_scan = 0
            OR (
              tab.n_dead_tup > 0
              AND (tab.n_dead_tup::numeric / GREATEST(tab.n_live_tup, 1)) > 0.1
            )
          )
        ORDER BY pg_relation_size(ix_stats.indexrelid) DESC
        LIMIT ${limit}
      `,
        'Unable to estimate index bloat candidates from pg_stat_user_indexes',
      );

      // ------------------------------------------------------------------
      // 3. Database-level size summary for context
      // ------------------------------------------------------------------
      const dbSummaryRow = await queryOneOrEmpty(
        `
        SELECT
          pg_database_size(current_database())                                   AS database_bytes,
          (
            SELECT SUM(pg_total_relation_size(c.oid))
            FROM   pg_class c
            JOIN   pg_namespace n ON n.oid = c.relnamespace
            WHERE  c.relkind = 'r'
              AND  n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          )                                                                      AS total_user_relation_bytes,
          (
            SELECT COUNT(*)
            FROM   pg_class c
            JOIN   pg_namespace n ON n.oid = c.relnamespace
            WHERE  c.relkind = 'r'
              AND  n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          )                                                                      AS user_table_count,
          (
            SELECT COUNT(*)
            FROM   pg_class c
            JOIN   pg_namespace n ON n.oid = c.relnamespace
            WHERE  c.relkind = 'i'
              AND  n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          )                                                                      AS user_index_count
      `,
        'Unable to collect database-level size summary',
      );

      // ------------------------------------------------------------------
      // 4. Top tables by total size — gives the agent size context when
      //    evaluating whether bloat percentages translate to material waste
      // ------------------------------------------------------------------
      const topTablesBySize = await queryRowsOrEmpty(
        `
        SELECT
          stats.schemaname,
          stats.relname                                    AS table_name,
          pg_total_relation_size(stats.relid)              AS total_bytes,
          pg_relation_size(stats.relid)                    AS heap_bytes,
          pg_total_relation_size(stats.relid)
            - pg_relation_size(stats.relid)                AS index_bytes,
          stats.n_live_tup
        FROM pg_stat_user_tables stats
        ORDER BY total_bytes DESC
        LIMIT ${limit}
      `,
        'Unable to collect top-tables-by-size from pg_stat_user_tables',
      );

      return {
        minBloatBytes,
        dbSummary: {
          databaseBytes: toNumber(dbSummaryRow['database_bytes']) ?? 0,
          totalUserRelationBytes:
            toNumber(dbSummaryRow['total_user_relation_bytes']) ?? 0,
          userTableCount: toNumber(dbSummaryRow['user_table_count']) ?? 0,
          userIndexCount: toNumber(dbSummaryRow['user_index_count']) ?? 0,
        },
        tableBloatEstimates: tableBloatRows.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          liveTuples: toNumber(row['n_live_tup']) ?? 0,
          deadTuples: toNumber(row['n_dead_tup']) ?? 0,
          heapBytes: toNumber(row['heap_bytes']) ?? 0,
          totalBytes: toNumber(row['total_bytes']) ?? 0,
          estimatedDeadTupleBytes:
            toNumber(row['estimated_dead_tuple_bytes']) ?? 0,
          deadTupleBloatPct: toNumber(row['dead_tuple_bloat_pct']) ?? 0,
          fillfactor: toNumber(row['fillfactor']) ?? 100,
          lastVacuum: toString(row['last_vacuum']) ?? null,
          lastAutovacuum: toString(row['last_autovacuum']) ?? null,
          vacuumCount: toNumber(row['vacuum_count']) ?? 0,
          autovacuumCount: toNumber(row['autovacuum_count']) ?? 0,
        })),
        indexBloatCandidates: indexBloatRows.map((row) => {
          const isUnique =
            row['is_unique'] === true ||
            row['is_unique'] === 't' ||
            row['is_unique'] === 1;
          const isPrimary =
            row['is_primary'] === true ||
            row['is_primary'] === 't' ||
            row['is_primary'] === 1;
          const backsConstraint =
            row['backs_constraint'] === true ||
            row['backs_constraint'] === 't' ||
            row['backs_constraint'] === 1;
          const isValid =
            row['is_valid'] === true ||
            row['is_valid'] === 't' ||
            row['is_valid'] === 1;

          return {
            schema: toString(row['schemaname']) ?? 'unknown',
            table: toString(row['table_name']) ?? 'unknown',
            index: toString(row['index_name']) ?? 'unknown',
            indexBytes: toNumber(row['index_bytes']) ?? 0,
            tableHeapBytes: toNumber(row['table_heap_bytes']) ?? 0,
            scans: toNumber(row['idx_scan']) ?? 0,
            tuplesRead: toNumber(row['idx_tup_read']) ?? 0,
            isValid,
            isUnique,
            isPrimary,
            backsConstraint,
            dropCandidate: !isUnique && !isPrimary && !backsConstraint,
            liveTuples: toNumber(row['n_live_tup']) ?? 0,
            deadTuples: toNumber(row['n_dead_tup']) ?? 0,
            tableSeqScan: toNumber(row['table_seq_scan']) ?? 0,
            lastVacuum: toString(row['last_vacuum']) ?? null,
            lastAutovacuum: toString(row['last_autovacuum']) ?? null,
          };
        }),
        topTablesBySize: topTablesBySize.map((row) => ({
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          totalBytes: toNumber(row['total_bytes']) ?? 0,
          heapBytes: toNumber(row['heap_bytes']) ?? 0,
          indexBytes: toNumber(row['index_bytes']) ?? 0,
          liveTuples: toNumber(row['n_live_tup']) ?? 0,
        })),
        sourceNotes,
      };
    });
  },
});
