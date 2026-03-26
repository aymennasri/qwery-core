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
  'Assess PostgreSQL index health: sequential-scan pressure, unused indexes, and duplicate index candidates.';

function toBoolean(value: unknown): boolean {
  return (
    value === true ||
    value === 1 ||
    value === '1' ||
    value === 't' ||
    value === 'true'
  );
}

export const GetIndexHealthTool = Tool.define('get_index_health', {
  description: DESCRIPTION,
  parameters: z.object({
    limit: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum rows per index-health section (default: 15).'),
  }),
  async execute(params, ctx) {
    const limit = toSafeLimit(params.limit, 15, 50);

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `db-performance-audit currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const seqScanPressureResult = await query(`
        SELECT
          schemaname,
          relname AS table_name,
          seq_scan,
          idx_scan,
          n_live_tup,
          (seq_scan::numeric * GREATEST(n_live_tup, 1)::numeric) AS estimated_seq_rows_read,
          CASE
            WHEN (seq_scan + idx_scan) = 0 THEN 0
            ELSE ROUND((seq_scan::numeric / (seq_scan + idx_scan)) * 100, 2)
          END AS seq_scan_ratio
        FROM pg_stat_user_tables
        WHERE (seq_scan + idx_scan) > 0
        ORDER BY estimated_seq_rows_read DESC, seq_scan DESC
        LIMIT ${limit}
      `);

      const unusedIndexesResult = await query(`
        SELECT
          stats.schemaname,
          stats.relname AS table_name,
          stats.indexrelname AS index_name,
          stats.idx_scan,
          pg_relation_size(stats.indexrelid) AS index_size_bytes,
          index_meta.indisunique AS is_unique,
          index_meta.indisprimary AS is_primary,
          EXISTS (
            SELECT 1
            FROM pg_constraint constraint_meta
            WHERE constraint_meta.conindid = stats.indexrelid
          ) AS backs_constraint
        FROM pg_stat_user_indexes stats
        JOIN pg_index index_meta ON index_meta.indexrelid = stats.indexrelid
        WHERE stats.idx_scan = 0
        ORDER BY pg_relation_size(stats.indexrelid) DESC
        LIMIT ${limit}
      `);

      const duplicateIndexesResult = await query(`
        SELECT
          schemaname,
          tablename,
          regexp_replace(indexdef, '^CREATE\\s+(UNIQUE\\s+)?INDEX\\s+[^ ]+\\s+ON\\s+', 'ON ') AS index_signature,
          array_agg(indexname) AS index_names,
          COUNT(*)::bigint AS duplicate_count
        FROM pg_indexes
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        GROUP BY schemaname, tablename, index_signature
        HAVING COUNT(*) > 1
        ORDER BY duplicate_count DESC
        LIMIT ${limit}
      `);

      const highSeqScanTables = seqScanPressureResult.rows.map((row) => ({
        schema: toString(row['schemaname']) ?? 'unknown',
        table: toString(row['table_name']) ?? 'unknown',
        seqScan: toNumber(row['seq_scan']) ?? 0,
        idxScan: toNumber(row['idx_scan']) ?? 0,
        liveTuples: toNumber(row['n_live_tup']) ?? 0,
        estimatedSeqRowsRead: toNumber(row['estimated_seq_rows_read']) ?? 0,
        seqScanRatio: toNumber(row['seq_scan_ratio']) ?? 0,
      }));

      const unusedIndexes = unusedIndexesResult.rows.map((row) => {
        const isUnique = toBoolean(row['is_unique']);
        const isPrimary = toBoolean(row['is_primary']);
        const backsConstraint = toBoolean(row['backs_constraint']);

        return {
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['table_name']) ?? 'unknown',
          index: toString(row['index_name']) ?? 'unknown',
          scans: toNumber(row['idx_scan']) ?? 0,
          sizeBytes: toNumber(row['index_size_bytes']) ?? 0,
          isUnique,
          isPrimary,
          backsConstraint,
          dropCandidate: !isUnique && !isPrimary && !backsConstraint,
        };
      });

      const duplicateIndexes = duplicateIndexesResult.rows.map((row) => {
        const indexNamesRaw = row['index_names'];
        const indexNames = Array.isArray(indexNamesRaw)
          ? indexNamesRaw.map((item) => toString(item) ?? 'unknown')
          : [];

        return {
          schema: toString(row['schemaname']) ?? 'unknown',
          table: toString(row['tablename']) ?? 'unknown',
          indexSignature: toString(row['index_signature']) ?? 'unknown',
          indexNames,
          duplicateCount: toNumber(row['duplicate_count']) ?? indexNames.length,
        };
      });

      return {
        limit,
        highSeqScanTables,
        unusedIndexes,
        duplicateIndexes,
      };
    });
  },
});
