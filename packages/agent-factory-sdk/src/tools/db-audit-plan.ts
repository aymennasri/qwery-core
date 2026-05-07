import { z } from 'zod';

import {
  assertExplainTargetSql,
  isPostgresDatasource,
  toNumber,
  withDatasourceDriver,
} from './db-audit/shared';
import { Tool } from './tool';

const DESCRIPTION =
  'Run bounded PostgreSQL EXPLAIN/EXPLAIN ANALYZE for a read-only query and return compact audit metrics without the raw plan tree.';

type PlanObject = Record<string, unknown>;

type SlowNode = {
  nodeType: string;
  relation: string | null;
  index: string | null;
  actualTotalTimeMs: number | null;
  actualLoops: number | null;
  totalContributionMs: number | null;
  planRows: number | null;
  actualRows: number | null;
  rowSkewRatio: number | null;
  sharedReadBlocks: number | null;
  sharedHitBlocks: number | null;
};

type SpillSignals = {
  spilled: boolean;
  details: string[];
};

function readPlanPayload(row: Record<string, unknown>): unknown {
  return row['QUERY PLAN'] ?? Object.values(row)[0];
}

function parsePlanObject(payload: unknown): PlanObject {
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;

  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (typeof first === 'object' && first !== null) return first as PlanObject;
  }

  if (typeof parsed === 'object' && parsed !== null)
    return parsed as PlanObject;

  throw new Error('Failed to parse EXPLAIN JSON plan payload.');
}

function walkPlan(node: unknown, visit: (item: PlanObject) => void): void {
  if (typeof node !== 'object' || node === null) return;

  const planNode = node as PlanObject;
  visit(planNode);

  const children = planNode['Plans'];
  if (!Array.isArray(children)) return;

  for (const child of children) walkPlan(child, visit);
}

function str(node: PlanObject, key: string): string | null {
  const value = node[key];
  return typeof value === 'string' ? value : null;
}

function num(node: PlanObject, key: string): number | null {
  return toNumber(node[key]);
}

function topSlowNodes(root: PlanObject, topN: number): SlowNode[] {
  const nodes: SlowNode[] = [];

  walkPlan(root, (node) => {
    const actualTotalTimeMs = num(node, 'Actual Total Time');
    const actualLoops = num(node, 'Actual Loops') ?? 1;
    const planRows = num(node, 'Plan Rows');
    const actualRows = num(node, 'Actual Rows');
    const totalContributionMs =
      actualTotalTimeMs === null ? null : actualTotalTimeMs * actualLoops;
    const rowSkewRatio =
      planRows !== null && planRows > 0 && actualRows !== null
        ? Number((actualRows / planRows).toFixed(2))
        : null;

    nodes.push({
      nodeType: str(node, 'Node Type') ?? 'Unknown',
      relation: str(node, 'Relation Name') ?? str(node, 'Alias'),
      index: str(node, 'Index Name'),
      actualTotalTimeMs,
      actualLoops,
      totalContributionMs,
      planRows,
      actualRows,
      rowSkewRatio,
      sharedReadBlocks: num(node, 'Shared Read Blocks'),
      sharedHitBlocks: num(node, 'Shared Hit Blocks'),
    });
  });

  return nodes
    .filter((node) => node.totalContributionMs !== null)
    .sort((a, b) => (b.totalContributionMs ?? 0) - (a.totalContributionMs ?? 0))
    .slice(0, topN);
}

function detectSpillSignals(
  root: PlanObject | null,
  tempReadBlocks: number | null,
  tempWriteBlocks: number | null,
): SpillSignals {
  const details: string[] = [];

  if ((tempReadBlocks ?? 0) > 0 || (tempWriteBlocks ?? 0) > 0) {
    details.push(
      `Temp blocks read/written: ${tempReadBlocks ?? 0}/${tempWriteBlocks ?? 0}.`,
    );
  }

  if (root) {
    walkPlan(root, (node) => {
      const nodeType = str(node, 'Node Type');
      const sortMethod = str(node, 'Sort Method')?.toLowerCase() ?? '';
      const sortSpaceType = str(node, 'Sort Space Type')?.toLowerCase() ?? '';
      const hashBatches = num(node, 'Hash Batches');

      if (
        nodeType === 'Sort' &&
        (sortMethod.includes('disk') || sortSpaceType === 'disk')
      ) {
        details.push('Sort used disk storage.');
      }

      if (nodeType === 'Hash' && hashBatches !== null && hashBatches > 1) {
        details.push(`Hash used ${hashBatches} batches.`);
      }
    });
  }

  return { spilled: details.length > 0, details };
}

function buildHighlights(input: {
  executionTimeMs: number | null;
  rootNode: string | null;
  worstNode: string | null;
  spilled: boolean;
  spillDetails: string[];
  parallelUsed: boolean;
  rowEstimateSkew: number | null;
  topSlowNodes: SlowNode[];
}): string[] {
  const highlights: string[] = [];

  if (input.executionTimeMs !== null && input.executionTimeMs >= 500) {
    highlights.push(
      `Execution time is elevated (${input.executionTimeMs.toFixed(2)} ms).`,
    );
  }

  if (input.rowEstimateSkew !== null && input.rowEstimateSkew >= 5) {
    highlights.push(
      `Root cardinality skew is ${input.rowEstimateSkew.toFixed(2)}x actual/estimated rows.`,
    );
  }

  if (input.worstNode) highlights.push(`Worst node: ${input.worstNode}.`);
  if (input.spilled) {
    highlights.push(
      `Sort/hash spill or temp blocks detected: ${input.spillDetails.join(' ')}`,
    );
  }
  if (input.parallelUsed) highlights.push('Parallel query execution was used.');

  return highlights;
}

export const DbAuditPlanTool = Tool.define('db_audit_plan', {
  description: DESCRIPTION,
  parameters: z.object({
    label: z.string().min(1).describe('Short audit label for this plan.'),
    query: z.string().min(1).describe('Read-only SELECT/WITH query to plan.'),
    mode: z.enum(['analyze', 'explain']).optional().default('analyze'),
    capture: z
      .object({
        topNodes: z.number().int().positive().max(10).optional(),
        highlights: z.number().int().positive().max(10).optional(),
      })
      .optional(),
  }),
  async execute(params, ctx) {
    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `db-performance-audit currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const userQuery = params.query.trim().replace(/;+$/, '');
      assertExplainTargetSql(userQuery, 'db_audit_plan');

      const analyze = params.mode !== 'explain';
      const explainPrefix = analyze
        ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)'
        : 'EXPLAIN (BUFFERS, FORMAT JSON)';
      const planResult = await query(`${explainPrefix} ${userQuery}`);
      const firstRow = planResult.rows[0];

      if (!firstRow) throw new Error('No plan rows were returned by EXPLAIN.');

      const planObject = parsePlanObject(readPlanPayload(firstRow));
      const root =
        typeof planObject['Plan'] === 'object' && planObject['Plan'] !== null
          ? (planObject['Plan'] as PlanObject)
          : null;

      const executionTimeMs = toNumber(planObject['Execution Time']);
      const planningTimeMs = toNumber(planObject['Planning Time']);
      const totalTimeMs =
        executionTimeMs === null && planningTimeMs === null
          ? null
          : (executionTimeMs ?? 0) + (planningTimeMs ?? 0);
      const planRows = root ? num(root, 'Plan Rows') : null;
      const actualRows = root ? num(root, 'Actual Rows') : null;
      const actualLoops = root ? (num(root, 'Actual Loops') ?? 1) : 1;
      const rowEstimateSkew =
        planRows !== null && planRows > 0 && actualRows !== null
          ? Number(((actualRows * actualLoops) / planRows).toFixed(2))
          : null;
      const nodes = root
        ? topSlowNodes(root, params.capture?.topNodes ?? 5)
        : [];
      const worst = nodes[0];
      const worstNode = worst
        ? `${worst.nodeType}${worst.relation ? ` on ${worst.relation}` : ''}`
        : null;
      const rootNode = root ? str(root, 'Node Type') : null;
      const tempReadBlocks = toNumber(planObject['Temp Read Blocks']);
      const tempWriteBlocks = toNumber(planObject['Temp Written Blocks']);
      const spillSignals = detectSpillSignals(
        root,
        tempReadBlocks,
        tempWriteBlocks,
      );
      const parallelUsed = root
        ? (() => {
            let found = false;
            walkPlan(root, (node) => {
              const type = str(node, 'Node Type');
              if (type === 'Gather' || type === 'Gather Merge') found = true;
            });
            return found;
          })()
        : false;
      const highlights = buildHighlights({
        executionTimeMs,
        rootNode,
        worstNode,
        spilled: spillSignals.spilled,
        spillDetails: spillSignals.details,
        parallelUsed,
        rowEstimateSkew,
        topSlowNodes: nodes,
      }).slice(0, params.capture?.highlights ?? 5);

      return {
        label: params.label,
        totalTimeMs,
        executionTimeMs,
        planningTimeMs,
        rootNode,
        worstNode,
        sharedReadBlocks: toNumber(planObject['Shared Read Blocks']),
        sharedHitBlocks: toNumber(planObject['Shared Hit Blocks']),
        tempReadBlocks,
        tempWriteBlocks,
        spilled: spillSignals.spilled,
        spillDetails: spillSignals.details,
        parallelUsed,
        rowEstimateSkew,
        topSlowNodes: nodes,
        highlights,
      };
    });
  },
});
