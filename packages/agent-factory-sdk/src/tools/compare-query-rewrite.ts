import { z } from 'zod';

import {
  assertExplainTargetSql,
  isPostgresDatasource,
  toNumber,
  withDatasourceDriver,
} from './db-audit/shared';
import { Tool } from './tool';

const DESCRIPTION =
  'Compare an original read-only SQL query against a rewritten read-only SQL query on the attached PostgreSQL datasource. Runs EXPLAIN ANALYZE with buffers for both queries, optionally checks result equivalence, and returns timing, plan, and confidence signals for query-shape optimization.';

const MAX_RUNS = 5;
const DEFAULT_RUNS = 3;
const MAX_EQUIVALENCE_ROWS = 1000;
const MAX_AUTO_EQUIVALENCE_TOTAL_TIME_MS = 10_000;

type PlanObject = Record<string, unknown>;

type ExplainMetrics = {
  planningTimeMs: number | null;
  executionTimeMs: number | null;
  totalTimeMs: number | null;
  rootNodeType: string;
  planRows: number | null;
  actualRows: number | null;
  sharedHitBlocks: number | null;
  sharedReadBlocks: number | null;
  tempReadBlocks: number | null;
  tempWrittenBlocks: number | null;
  accessPathSignature: string;
};

type EquivalenceResult =
  | {
      checked: true;
      equivalent: boolean;
      rowCountMatches: boolean;
      checkedRows: number;
      caveat: string | null;
    }
  | {
      checked: false;
      caveat: string;
    };

function buildExplainSql(query: string): string {
  const trimmed = query.trim().replace(/;\s*$/, '');
  return `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${trimmed}`;
}

function readPlanPayload(row: Record<string, unknown>): unknown {
  return row['QUERY PLAN'] ?? Object.values(row)[0];
}

function parsePlanPayload(payload: unknown): PlanObject {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  if (Array.isArray(parsed) && typeof parsed[0] === 'object' && parsed[0]) {
    return parsed[0] as PlanObject;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    return parsed as PlanObject;
  }
  throw new Error('Failed to parse EXPLAIN JSON plan payload.');
}

function nodeNumber(node: PlanObject, key: string): number | null {
  return toNumber(node[key]);
}

function nodeString(node: PlanObject, key: string): string | null {
  const value = node[key];
  return typeof value === 'string' ? value : null;
}

function walkPlan(node: unknown, visit: (item: PlanObject) => void): void {
  if (typeof node !== 'object' || node === null) return;
  const planNode = node as PlanObject;
  visit(planNode);
  const children = planNode['Plans'];
  if (!Array.isArray(children)) return;
  for (const child of children) walkPlan(child, visit);
}

function collectAccessPaths(root: PlanObject): string[] {
  const paths: string[] = [];
  walkPlan(root, (node) => {
    const nodeType = nodeString(node, 'Node Type');
    if (!nodeType) return;
    if (!/(Scan|Join|Aggregate|Sort|Gather|Materialize)/i.test(nodeType)) {
      return;
    }
    const relation = nodeString(node, 'Relation Name');
    const index = nodeString(node, 'Index Name');
    paths.push([nodeType, relation, index].filter(Boolean).join(':'));
  });
  return paths;
}

function summarizeExplain(row: Record<string, unknown>): ExplainMetrics {
  const explain = parsePlanPayload(readPlanPayload(row));
  const root = explain['Plan'] as PlanObject | undefined;
  if (!root) throw new Error('EXPLAIN JSON payload does not include a Plan.');

  return {
    planningTimeMs: nodeNumber(explain, 'Planning Time'),
    executionTimeMs: nodeNumber(explain, 'Execution Time'),
    totalTimeMs:
      nodeNumber(explain, 'Planning Time') !== null &&
      nodeNumber(explain, 'Execution Time') !== null
        ? Number(
            (
              (nodeNumber(explain, 'Planning Time') ?? 0) +
              (nodeNumber(explain, 'Execution Time') ?? 0)
            ).toFixed(3),
          )
        : null,
    rootNodeType: nodeString(root, 'Node Type') ?? 'Unknown',
    planRows: nodeNumber(root, 'Plan Rows'),
    actualRows: nodeNumber(root, 'Actual Rows'),
    sharedHitBlocks: nodeNumber(root, 'Shared Hit Blocks'),
    sharedReadBlocks: nodeNumber(root, 'Shared Read Blocks'),
    tempReadBlocks: nodeNumber(root, 'Temp Read Blocks'),
    tempWrittenBlocks: nodeNumber(root, 'Temp Written Blocks'),
    accessPathSignature: collectAccessPaths(root).join('|'),
  };
}

function average(values: Array<number | null>): number | null {
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;
  return Number(
    (numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(
      3,
    ),
  );
}

function normalizeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function normalizeRows(rows: Array<Record<string, unknown>>): string[] {
  return rows.map((row) =>
    JSON.stringify(
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]),
      ),
    ),
  );
}

function compareResults(
  originalRows: Array<Record<string, unknown>>,
  rewrittenRows: Array<Record<string, unknown>>,
): { equivalent: boolean; rowCountMatches: boolean; checkedRows: number } {
  const original = normalizeRows(originalRows).sort();
  const rewritten = normalizeRows(rewrittenRows).sort();
  const rowCountMatches = original.length === rewritten.length;
  return {
    equivalent:
      rowCountMatches &&
      original.every((value, index) => value === rewritten[index]),
    rowCountMatches,
    checkedRows: Math.max(original.length, rewritten.length),
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() !== ''
    ? error.message.split('\n')[0]?.trim() || 'unknown error'
    : 'unknown error';
}

export const CompareQueryRewriteTool = Tool.define('compare_query_rewrite', {
  description: DESCRIPTION,
  parameters: z.object({
    originalQuery: z
      .string()
      .describe('Original SELECT or WITH query to benchmark.'),
    rewrittenQuery: z
      .string()
      .describe(
        'Rewritten SELECT or WITH query to benchmark against the original.',
      ),
    runs: z
      .number()
      .int()
      .positive()
      .max(MAX_RUNS)
      .optional()
      .default(DEFAULT_RUNS)
      .describe(
        'Number of EXPLAIN ANALYZE runs for each query. Default 3, max 5.',
      ),
    checkEquivalence: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        'When true, execute both read-only queries directly and compare up to 1000 returned rows as an unordered set.',
      ),
  }),
  async execute(params, ctx) {
    assertExplainTargetSql(params.originalQuery, 'compare_query_rewrite');
    assertExplainTargetSql(params.rewrittenQuery, 'compare_query_rewrite');

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `compare_query_rewrite currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const runs = Math.min(Math.max(params.runs ?? DEFAULT_RUNS, 1), MAX_RUNS);
      const originalRuns: ExplainMetrics[] = [];
      const rewrittenRuns: ExplainMetrics[] = [];
      const runErrors: string[] = [];

      for (let i = 0; i < runs; i += 1) {
        try {
          const originalExplain = await query(
            buildExplainSql(params.originalQuery),
          );
          const rewrittenExplain = await query(
            buildExplainSql(params.rewrittenQuery),
          );
          const originalRow = originalExplain.rows[0];
          const rewrittenRow = rewrittenExplain.rows[0];
          if (!originalRow || !rewrittenRow) {
            throw new Error('EXPLAIN returned no rows for query comparison.');
          }
          originalRuns.push(summarizeExplain(originalRow));
          rewrittenRuns.push(summarizeExplain(rewrittenRow));
        } catch (error) {
          runErrors.push(`run ${i + 1}: ${getErrorMessage(error)}`);
          if (originalRuns.length === 0 || rewrittenRuns.length === 0) {
            throw error;
          }
          break;
        }
      }

      const originalAverageTotalTimeMs = average(
        originalRuns.map((run) => run.totalTimeMs),
      );
      const rewrittenAverageTotalTimeMs = average(
        rewrittenRuns.map((run) => run.totalTimeMs),
      );
      const totalTimeDeltaMs =
        originalAverageTotalTimeMs !== null &&
        rewrittenAverageTotalTimeMs !== null
          ? Number(
              (
                rewrittenAverageTotalTimeMs - originalAverageTotalTimeMs
              ).toFixed(3),
            )
          : null;
      const totalTimeDeltaPct =
        totalTimeDeltaMs !== null &&
        originalAverageTotalTimeMs !== null &&
        originalAverageTotalTimeMs > 0
          ? Number(
              ((totalTimeDeltaMs / originalAverageTotalTimeMs) * 100).toFixed(
                2,
              ),
            )
          : null;

      let equivalence: EquivalenceResult | undefined;

      if (params.checkEquivalence) {
        const maxAverageTotalTimeMs = Math.max(
          originalAverageTotalTimeMs ?? 0,
          rewrittenAverageTotalTimeMs ?? 0,
        );

        if (maxAverageTotalTimeMs > MAX_AUTO_EQUIVALENCE_TOTAL_TIME_MS) {
          equivalence = {
            checked: false,
            caveat: `Result equivalence check was skipped because the measured query runtime exceeded ${MAX_AUTO_EQUIVALENCE_TOTAL_TIME_MS}ms; rerunning both queries directly may hit datasource timeout limits.`,
          };
        } else {
          try {
            const originalResult = await query(
              `SELECT * FROM (${params.originalQuery.trim().replace(/;\s*$/, '')}) AS original_query_rewrite_check LIMIT ${MAX_EQUIVALENCE_ROWS}`,
            );
            const rewrittenResult = await query(
              `SELECT * FROM (${params.rewrittenQuery.trim().replace(/;\s*$/, '')}) AS rewritten_query_rewrite_check LIMIT ${MAX_EQUIVALENCE_ROWS}`,
            );
            const comparison = compareResults(
              originalResult.rows,
              rewrittenResult.rows,
            );
            equivalence = {
              checked: true,
              ...comparison,
              caveat:
                comparison.checkedRows >= MAX_EQUIVALENCE_ROWS
                  ? `Only the first ${MAX_EQUIVALENCE_ROWS} rows from each query were compared; use a stronger query-specific checksum for full equivalence.`
                  : null,
            };
          } catch (error) {
            equivalence = {
              checked: false,
              caveat: `Result equivalence check failed after plan comparison completed: ${getErrorMessage(error)}.`,
            };
          }
        }
      }

      const originalLast = originalRuns[originalRuns.length - 1];
      const rewrittenLast = rewrittenRuns[rewrittenRuns.length - 1];

      return {
        datasource: {
          id: datasource.id,
          name: datasource.name,
          provider: datasource.datasource_provider,
        },
        originalDatabaseUnchanged: true,
        comparisonType: 'read-only-query-rewrite',
        requestedRuns: runs,
        completedRuns: originalRuns.length,
        runErrors,
        original: {
          query: params.originalQuery.trim(),
          averageTotalTimeMs: originalAverageTotalTimeMs,
          averageExecutionTimeMs: average(
            originalRuns.map((run) => run.executionTimeMs),
          ),
          lastPlan: originalLast,
          runs: originalRuns,
        },
        rewritten: {
          query: params.rewrittenQuery.trim(),
          averageTotalTimeMs: rewrittenAverageTotalTimeMs,
          averageExecutionTimeMs: average(
            rewrittenRuns.map((run) => run.executionTimeMs),
          ),
          lastPlan: rewrittenLast,
          runs: rewrittenRuns,
        },
        delta: {
          totalTimeMs: totalTimeDeltaMs,
          totalTimePct: totalTimeDeltaPct,
          improved:
            totalTimeDeltaMs !== null && totalTimeDeltaMs < 0 ? true : false,
          planShapeChanged:
            originalLast?.accessPathSignature !==
            rewrittenLast?.accessPathSignature,
        },
        equivalence: equivalence ?? {
          checked: false,
          caveat: 'Result equivalence check was skipped.',
        },
      };
    });
  },
});
