import { z } from 'zod';

import {
  assertExplainTargetSql,
  isPostgresDatasource,
  toNumber,
  withDatasourceDriver,
} from './db-audit/shared';
import { Tool } from './tool';

const DESCRIPTION =
  'Run EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for a read-only SQL query and return plan metrics including per-node worst-path analysis, Sort/Hash spill detection, parallel worker stats, and bitmap heap scan lossy-page information.';

type PlanObject = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Plan parsing helpers
// ---------------------------------------------------------------------------

function readPlanPayload(row: Record<string, unknown>): unknown {
  const preferred = row['QUERY PLAN'];
  if (preferred !== undefined) return preferred;
  const values = Object.values(row);
  return values[0];
}

function parsePlanObject(payload: unknown): PlanObject {
  let parsed: unknown = payload;

  if (typeof payload === 'string') {
    parsed = JSON.parse(payload);
  }

  if (Array.isArray(parsed)) {
    const first = parsed[0];
    if (typeof first === 'object' && first !== null) {
      return first as PlanObject;
    }
  }

  if (typeof parsed === 'object' && parsed !== null) {
    return parsed as PlanObject;
  }

  throw new Error('Failed to parse EXPLAIN JSON plan payload.');
}

function walkPlan(node: unknown, visit: (item: PlanObject) => void): void {
  if (typeof node !== 'object' || node === null) return;

  const planNode = node as PlanObject;
  visit(planNode);

  const children = planNode['Plans'];
  if (!Array.isArray(children)) return;

  for (const child of children) {
    walkPlan(child, visit);
  }
}

function num(node: PlanObject, key: string): number | null {
  const v = node[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const p = Number(v);
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function str(node: PlanObject, key: string): string | null {
  const v = node[key];
  return typeof v === 'string' ? v : null;
}

// ---------------------------------------------------------------------------
// Per-node analysis types
// ---------------------------------------------------------------------------

type SlowNode = {
  nodeType: string;
  relation: string | null;
  index: string | null;
  actualTotalTimeMs: number;
  actualLoops: number;
  totalContributionMs: number;
  planRows: number | null;
  actualRows: number | null;
  rowSkewRatio: number | null;
  sharedHitBlocks: number | null;
  sharedReadBlocks: number | null;
};

type SpillInfo = {
  kind: 'sort' | 'hash';
  nodeType: string;
  spilled: boolean;
  detail: string;
};

type GatherInfo = {
  nodeType: string;
  workersPlanned: number | null;
  workersLaunched: number | null;
  singleCopy: boolean;
};

type BitmapScanInfo = {
  relation: string | null;
  exactHeapFetches: number | null;
  lossyHeapFetches: number | null;
  lossyPct: number | null;
};

type NodeCounters = {
  seqScanNodes: number;
  indexScanNodes: number;
  bitmapIndexScanNodes: number;
  nestedLoopNodes: number;
  hashJoinNodes: number;
  mergeJoinNodes: number;
  sortNodes: number;
  hashNodes: number;
  gatherNodes: number;
  materializeNodes: number;
};

// ---------------------------------------------------------------------------
// Walk-based extractors
// ---------------------------------------------------------------------------

function extractNodeCounters(root: PlanObject): NodeCounters {
  const c: NodeCounters = {
    seqScanNodes: 0,
    indexScanNodes: 0,
    bitmapIndexScanNodes: 0,
    nestedLoopNodes: 0,
    hashJoinNodes: 0,
    mergeJoinNodes: 0,
    sortNodes: 0,
    hashNodes: 0,
    gatherNodes: 0,
    materializeNodes: 0,
  };

  walkPlan(root, (node) => {
    const t = str(node, 'Node Type') ?? '';
    if (t === 'Seq Scan') c.seqScanNodes += 1;
    else if (t === 'Index Scan' || t === 'Index Only Scan')
      c.indexScanNodes += 1;
    else if (t === 'Bitmap Index Scan') c.bitmapIndexScanNodes += 1;
    else if (t === 'Nested Loop') c.nestedLoopNodes += 1;
    else if (t === 'Hash Join') c.hashJoinNodes += 1;
    else if (t === 'Merge Join') c.mergeJoinNodes += 1;
    else if (t === 'Sort') c.sortNodes += 1;
    else if (t === 'Hash') c.hashNodes += 1;
    else if (t === 'Gather' || t === 'Gather Merge') c.gatherNodes += 1;
    else if (t === 'Materialize') c.materializeNodes += 1;
  });

  return c;
}

function extractTopSlowNodes(root: PlanObject, topN = 5): SlowNode[] {
  const nodes: SlowNode[] = [];

  walkPlan(root, (node) => {
    const actualTotalTimeMs = num(node, 'Actual Total Time');
    const actualLoops = num(node, 'Actual Loops') ?? 1;
    if (actualTotalTimeMs === null) return;

    // total contribution = actualTotalTime * loops (PostgreSQL reports
    // per-loop times; multiply to get the wall-time budget consumed)
    const totalContributionMs = actualTotalTimeMs * actualLoops;

    const planRows = num(node, 'Plan Rows');
    const actualRows = num(node, 'Actual Rows');
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
      sharedHitBlocks: num(node, 'Shared Hit Blocks'),
      sharedReadBlocks: num(node, 'Shared Read Blocks'),
    });
  });

  return nodes
    .sort((a, b) => b.totalContributionMs - a.totalContributionMs)
    .slice(0, topN);
}

function extractSpills(root: PlanObject): SpillInfo[] {
  const spills: SpillInfo[] = [];

  walkPlan(root, (node) => {
    const t = str(node, 'Node Type') ?? '';

    // Sort spill: PostgreSQL reports "Sort Method" in the plan when ANALYZE
    // is used.  Any value containing "disk" indicates a work_mem spill.
    if (t === 'Sort') {
      const sortMethod = str(node, 'Sort Method') ?? '';
      const spaceUsed = num(node, 'Sort Space Used');
      const spaceType = str(node, 'Sort Space Type') ?? '';
      const spilled =
        sortMethod.toLowerCase().includes('disk') ||
        spaceType.toLowerCase() === 'disk';

      spills.push({
        kind: 'sort',
        nodeType: 'Sort',
        spilled,
        detail: spilled
          ? `Sort spilled to disk (method: ${sortMethod || 'external merge'}, space: ${spaceUsed != null ? `${spaceUsed} kB` : 'unknown'}).`
          : `Sort kept in memory (method: ${sortMethod || 'quicksort'}, space: ${spaceUsed != null ? `${spaceUsed} kB` : 'unknown'}).`,
      });
    }

    // Hash spill: Hash Batches > 1 means the hash table overflowed work_mem
    // and PostgreSQL batched it to disk.
    if (t === 'Hash') {
      const hashBatches = num(node, 'Hash Batches');
      const originalBatches = num(node, 'Original Hash Batches');
      const spilled = hashBatches !== null && hashBatches > 1;

      if (hashBatches !== null) {
        spills.push({
          kind: 'hash',
          nodeType: 'Hash',
          spilled,
          detail: spilled
            ? `Hash spilled to disk (batches: ${hashBatches}${originalBatches != null && originalBatches !== hashBatches ? `, original batches: ${originalBatches}` : ''}) — increase work_mem to keep in memory.`
            : `Hash kept in memory (batches: ${hashBatches}).`,
        });
      }
    }
  });

  return spills;
}

function extractGatherInfo(root: PlanObject): GatherInfo[] {
  const gathers: GatherInfo[] = [];

  walkPlan(root, (node) => {
    const t = str(node, 'Node Type') ?? '';
    if (t !== 'Gather' && t !== 'Gather Merge') return;

    gathers.push({
      nodeType: t,
      workersPlanned: num(node, 'Workers Planned'),
      workersLaunched: num(node, 'Workers Launched'),
      singleCopy:
        node['Single Copy'] === true || node['Single Copy'] === 'true',
    });
  });

  return gathers;
}

function extractBitmapScanInfo(root: PlanObject): BitmapScanInfo[] {
  const results: BitmapScanInfo[] = [];

  walkPlan(root, (node) => {
    const t = str(node, 'Node Type') ?? '';
    if (t !== 'Bitmap Heap Scan') return;

    const exact = num(node, 'Exact Heap Fetches');
    const lossy = num(node, 'Lossy Heap Fetches');
    const total = (exact ?? 0) + (lossy ?? 0);
    const lossyPct =
      total > 0 && lossy != null
        ? Number(((lossy / total) * 100).toFixed(2))
        : null;

    results.push({
      relation: str(node, 'Relation Name') ?? str(node, 'Alias'),
      exactHeapFetches: exact,
      lossyHeapFetches: lossy,
      lossyPct,
    });
  });

  return results;
}

// ---------------------------------------------------------------------------
// Highlight and metric summary helpers
// ---------------------------------------------------------------------------

function pushIfDefined(
  target: string[],
  label: string,
  value: number | null,
): void {
  if (value === null) return;
  target.push(`${label}: ${value.toFixed(2)}`);
}

function buildHighlights(
  executionTimeMs: number | null,
  counters: NodeCounters,
  planRows: number | null,
  actualRows: number | null,
  topSlowNodes: SlowNode[],
  spills: SpillInfo[],
  gathers: GatherInfo[],
  bitmapScans: BitmapScanInfo[],
): string[] {
  const h: string[] = [];

  if (executionTimeMs !== null && executionTimeMs >= 500) {
    h.push(`Execution time is elevated (${executionTimeMs.toFixed(2)} ms).`);
  }

  if (
    counters.seqScanNodes > 0 &&
    counters.indexScanNodes === 0 &&
    counters.bitmapIndexScanNodes === 0
  ) {
    h.push('Plan relies solely on sequential scans with no index usage.');
  }

  if (
    planRows !== null &&
    actualRows !== null &&
    planRows > 0 &&
    actualRows / planRows >= 5
  ) {
    h.push(
      `Root cardinality estimation mismatch (${(actualRows / planRows).toFixed(2)}x actual/estimated rows).`,
    );
  }

  const worstNode = topSlowNodes[0];
  if (worstNode && worstNode.totalContributionMs >= 100) {
    const label = worstNode.relation
      ? `${worstNode.nodeType} on ${worstNode.relation}`
      : worstNode.nodeType;
    h.push(
      `Slowest plan node: ${label} (${worstNode.totalContributionMs.toFixed(2)} ms total contribution, ${worstNode.actualLoops} loop(s)).`,
    );

    if (worstNode.rowSkewRatio !== null && worstNode.rowSkewRatio >= 5) {
      h.push(
        `Worst node has severe row-count skew: actual/estimated ratio ${worstNode.rowSkewRatio.toFixed(2)}x — stale statistics likely.`,
      );
    }
  }

  const diskSpills = spills.filter((s) => s.spilled);
  if (diskSpills.length > 0) {
    h.push(
      `${diskSpills.length} disk spill(s) detected (${diskSpills.map((s) => s.nodeType).join(', ')}) — work_mem may be insufficient.`,
    );
  }

  for (const g of gathers) {
    const planned = g.workersPlanned ?? 0;
    const launched = g.workersLaunched ?? 0;
    if (planned > 0 && launched < planned) {
      h.push(
        `Parallel query under-provisioned: ${launched}/${planned} workers launched (${g.nodeType}).`,
      );
    } else if (planned > 0) {
      h.push(`Parallel query used ${launched} worker(s) via ${g.nodeType}.`);
    }
  }

  for (const bs of bitmapScans) {
    if (bs.lossyPct !== null && bs.lossyPct > 0) {
      const rel = bs.relation ?? 'unknown';
      h.push(
        `Bitmap Heap Scan on ${rel} has ${bs.lossyPct.toFixed(1)}% lossy heap fetches — effective_work_mem may be too low for the bitmap, causing extra re-checks.`,
      );
    }
  }

  return h;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const ExplainQueryPlanTool = Tool.define('explain_query_plan', {
  description: DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .min(1)
      .describe('Read-only SQL query (SELECT/WITH) to analyze with EXPLAIN.'),
    analyze: z
      .boolean()
      .optional()
      .describe('When true (default), run EXPLAIN ANALYZE with BUFFERS.'),
  }),
  async execute(params, ctx) {
    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `This tool currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const userQuery = params.query.trim().replace(/;+$/, '');
      assertExplainTargetSql(userQuery);

      const analyze = params.analyze ?? true;
      const explainPrefix = analyze
        ? 'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)'
        : 'EXPLAIN (FORMAT JSON)';

      const planResult = await query(`${explainPrefix} ${userQuery}`);
      const firstRow = planResult.rows[0];
      if (!firstRow) {
        throw new Error('No plan rows were returned by EXPLAIN.');
      }

      const payload = readPlanPayload(firstRow);
      const planObject = parsePlanObject(payload);

      const rootNode =
        typeof planObject['Plan'] === 'object' && planObject['Plan'] !== null
          ? (planObject['Plan'] as PlanObject)
          : null;

      // -----------------------------------------------------------------
      // Top-level timing metrics
      // -----------------------------------------------------------------
      const executionTimeMs = toNumber(planObject['Execution Time']);
      const planningTimeMs = toNumber(planObject['Planning Time']);

      // Top-level buffer metrics (aggregate across all nodes)
      const sharedHitBlocks = toNumber(planObject['Shared Hit Blocks']);
      const sharedReadBlocks = toNumber(planObject['Shared Read Blocks']);
      const sharedDirtiedBlocks = toNumber(planObject['Shared Dirtied Blocks']);
      const sharedWrittenBlocks = toNumber(planObject['Shared Written Blocks']);
      const localHitBlocks = toNumber(planObject['Local Hit Blocks']);
      const localReadBlocks = toNumber(planObject['Local Read Blocks']);
      const tempReadBlocks = toNumber(planObject['Temp Read Blocks']);
      const tempWrittenBlocks = toNumber(planObject['Temp Written Blocks']);

      const totalCost = rootNode ? toNumber(rootNode['Total Cost']) : null;
      const planRows = rootNode ? toNumber(rootNode['Plan Rows']) : null;
      const actualRows = rootNode ? toNumber(rootNode['Actual Rows']) : null;
      const actualLoops = rootNode
        ? (toNumber(rootNode['Actual Loops']) ?? 1)
        : 1;

      // -----------------------------------------------------------------
      // Per-node deep analysis (only when ANALYZE was run)
      // -----------------------------------------------------------------
      const counters = rootNode
        ? extractNodeCounters(rootNode)
        : ({
            seqScanNodes: 0,
            indexScanNodes: 0,
            bitmapIndexScanNodes: 0,
            nestedLoopNodes: 0,
            hashJoinNodes: 0,
            mergeJoinNodes: 0,
            sortNodes: 0,
            hashNodes: 0,
            gatherNodes: 0,
            materializeNodes: 0,
          } satisfies NodeCounters);

      const topSlowNodes: SlowNode[] =
        analyze && rootNode ? extractTopSlowNodes(rootNode) : [];

      const spills: SpillInfo[] =
        analyze && rootNode ? extractSpills(rootNode) : [];

      const gathers: GatherInfo[] = rootNode ? extractGatherInfo(rootNode) : [];

      const bitmapScans: BitmapScanInfo[] =
        analyze && rootNode ? extractBitmapScanInfo(rootNode) : [];

      // -----------------------------------------------------------------
      // Cardinality skew at root level
      // -----------------------------------------------------------------
      const rootSkewRatio =
        planRows !== null && planRows > 0 && actualRows !== null
          ? Number(((actualRows * actualLoops) / planRows).toFixed(2))
          : null;

      // -----------------------------------------------------------------
      // Highlights (actionable observations for the agent)
      // -----------------------------------------------------------------
      const highlights = buildHighlights(
        executionTimeMs,
        counters,
        planRows,
        actualRows !== null ? actualRows * actualLoops : null,
        topSlowNodes,
        spills,
        gathers,
        bitmapScans,
      );

      // -----------------------------------------------------------------
      // Metric summary (flat key:value list for quick scanning)
      // -----------------------------------------------------------------
      const metricSummary: string[] = [];
      pushIfDefined(metricSummary, 'planning_time_ms', planningTimeMs);
      pushIfDefined(metricSummary, 'execution_time_ms', executionTimeMs);
      pushIfDefined(metricSummary, 'total_cost', totalCost);
      pushIfDefined(metricSummary, 'plan_rows', planRows);
      pushIfDefined(metricSummary, 'actual_rows', actualRows);
      pushIfDefined(
        metricSummary,
        'actual_loops',
        actualLoops !== 1 ? actualLoops : null,
      );
      pushIfDefined(metricSummary, 'root_skew_ratio', rootSkewRatio);
      pushIfDefined(metricSummary, 'shared_hit_blocks', sharedHitBlocks);
      pushIfDefined(metricSummary, 'shared_read_blocks', sharedReadBlocks);
      pushIfDefined(metricSummary, 'temp_written_blocks', tempWrittenBlocks);
      metricSummary.push(`seq_scan_nodes: ${counters.seqScanNodes}`);
      metricSummary.push(`index_scan_nodes: ${counters.indexScanNodes}`);
      if (counters.bitmapIndexScanNodes > 0)
        metricSummary.push(
          `bitmap_index_scan_nodes: ${counters.bitmapIndexScanNodes}`,
        );
      if (counters.gatherNodes > 0)
        metricSummary.push(`gather_nodes: ${counters.gatherNodes}`);
      if (spills.filter((s) => s.spilled).length > 0)
        metricSummary.push(
          `disk_spills: ${spills.filter((s) => s.spilled).length}`,
        );

      return {
        query: userQuery,
        analyze,

        metrics: {
          planningTimeMs,
          executionTimeMs,
          totalCost,
          planRows,
          actualRows,
          actualLoops,
          rootSkewRatio,
          sharedHitBlocks,
          sharedReadBlocks,
          sharedDirtiedBlocks,
          sharedWrittenBlocks,
          localHitBlocks,
          localReadBlocks,
          tempReadBlocks,
          tempWrittenBlocks,
          // Flattened node type counts for quick assertion
          ...counters,
        },

        // ---------------------------------------------------------------
        // Deep per-node analysis
        // ---------------------------------------------------------------
        topSlowNodes,
        spills,
        gathers,
        bitmapScans,

        highlights,
        metricSummary,

        // Full JSON plan for deeper agent analysis when needed
        plan: planObject,
      };
    });
  },
});
