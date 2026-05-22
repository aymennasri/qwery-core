import { describe, expect, it } from 'vitest';
import { AskAgent } from '../../src/agents/ask-agent';
import { QueryAgent } from '../../src/agents/query-agent';
import { SlowQueryOptimizerAgent } from '../../src/agents/slow-query-optimizer-agent';
import { SLOW_QUERY_OPTIMIZER_PROMPT } from '../../src/agents/prompts/slow-query-optimizer.prompt';
import { Registry } from '../../src/tools/registry';

const MODEL = { providerId: 'test', modelId: 'test' };

function createToolContext() {
  return {
    conversationId: 'conversation-1',
    agentId: 'test-agent',
    abort: new AbortController().signal,
    messages: [],
    ask: async () => {},
    metadata: () => {},
  };
}

describe('SlowQueryOptimizerAgent', () => {
  it('exposes the slow-query optimization tool allowlist', () => {
    const tools = SlowQueryOptimizerAgent.options?.tools as
      | Record<string, boolean>
      | undefined;

    expect(tools).toBeDefined();
    expect(tools?.detect_db_engine).toBe(true);
    expect(tools?.get_top_slow_queries).toBe(true);
    expect(tools?.explain_query_plan).toBe(true);
    expect(tools?.compare_query_rewrite).toBe(true);
    expect(tools?.get_statistics_health).toBe(true);
    expect(tools?.validate_remediation_in_gfs_cli).toBe(true);
    expect(tools?.runQuery).toBe(true);
    expect(tools?.runQueries).toBe(true);
    expect(tools?.get_index_health).toBeUndefined();
    expect(tools?.get_table_health).toBeUndefined();
    expect(tools?.get_infra_runtime_signals).toBeUndefined();
    expect(tools?.get_recent_db_logs).toBeUndefined();
    expect(tools?.get_lock_and_blocking_analysis).toBeUndefined();
    expect(tools?.get_bloat_estimates).toBeUndefined();
    expect(tools?.get_replication_health).toBeUndefined();
    expect(tools?.todowrite).toBeUndefined();
    expect(tools?.todoread).toBeUndefined();
  });

  it('keeps enough step budget for multi-phase optimization without todo tools', () => {
    expect(SlowQueryOptimizerAgent.steps).toBeGreaterThanOrEqual(60);
    expect(SLOW_QUERY_OPTIMIZER_PROMPT).not.toContain('todo list tool');
    expect(SLOW_QUERY_OPTIMIZER_PROMPT).not.toContain('track with todo tools');
  });

  it('instructs the agent to validate only evidence-backed query fixes', () => {
    const requiredPhrases = [
      'If no datasource is attached, stop immediately',
      'Focus only on the slowest user-facing queries. Do not perform broad database health review work.',
      'Always pull the slow-query candidates first with `get_top_slow_queries`',
      "Always inspect the original query's full execution plan for the chosen hotspot with `explain_query_plan`",
      'This agent is for SQL and query-shape optimization. It is not a broad database health reviewer, not a general index-tuning agent, and not a configuration-tuning agent.',
      'For every prioritized query, produce multiple rewritten SQL candidates when the plan evidence supports more than one plausible query-shape fix.',
      'A run is incomplete if you recommend an index, schema, maintenance, or configuration change without first directly comparing a rewritten SQL form of the same workload with `compare_query_rewrite`.',
      'By default, this agent should stop at rewritten SQL recommendations.',
      'Use the original datasource only for read-only diagnostics and evidence gathering',
      'Use `compare_query_rewrite` to test rewrite candidates and produce before/after diffs.',
      'Use `validate_remediation_in_gfs_cli` when isolated GFS execution is useful for comparing query candidates',
      'Do not include any suggested action anywhere in the final response unless it was directly compared with `compare_query_rewrite` or isolated GFS validation',
      "Configuration tuning is outside this optimizer's default workflow.",
      'Blocked - no validated query rewrite for this query.',
      'Choose representative validation literals from observed data distribution rather than arbitrary convenient values.',
      'Optimization incomplete: not all candidate rewrites could be compared.',
      '| Query | Rewrite | Validation Path | Original | Rewritten | Diff | Plan Change | Equivalence | Rollback | Outcome |',
      'reporting the measured before/after performance diff',
      'Scans: `Seq Scan`, `Index Scan`, `Index Only Scan`, `Bitmap Index Scan`, and `Bitmap Heap Scan`.',
      'Joins: `Nested Loop`, `Hash Join`, and `Merge Join`.',
      'Do not treat every `Seq Scan` as a problem.',
      'First try a query rewrite.',
      'Build candidates incrementally: first test the safest minimal rewrite, then test one or more stronger rewrites that attack the dominant plan cost.',
      'For the top hotspot, test 2 to 4 rewrite candidates when feasible.',
      'The final recommendation for a hotspot is the best validated rewrite among tested candidates, not merely the first rewrite that improves timing.',
      'replace correlated scalar subqueries with joined or preaggregated subqueries',
      'rewrite non-sargable predicates such as `date_trunc(column)` filters into plain timestamp ranges',
      'Always show the original SQL shape and the rewritten SQL candidate side by side',
      'Distinguish between high mean-latency queries and high cumulative-cost queries.',
      'The before/after diff should include timing, shared block reads/hits when available, temp reads/writes when available, plan-node changes, join or scan method changes, whether a spill disappeared, and result-equivalence status when checked.',
      'Do not imply that the rewritten comparison summary is a full-plan substitute.',
      'Original SQL shape anti-pattern',
      'Rewritten SQL candidates tested',
      'Best validated rewrite',
      'Optimization captured at',
      'Prefer rewrites that reduce rows earlier before considering any non-query remedy.',
      'If the rewrite result is inconclusive or insufficient, stop and state that rewrite-first testing did not prove a fix.',
      'Do not recommend index or schema changes in this agent unless the user explicitly asked for them.',
      'For up to 5 highest-impact slow queries, include:',
    ];

    for (const phrase of requiredPhrases) {
      expect(SLOW_QUERY_OPTIMIZER_PROMPT).toContain(phrase);
    }
  });

  it('registers every required slow-query optimization tool', async () => {
    const result = await Registry.tools.forAgent(
      SlowQueryOptimizerAgent.id,
      MODEL,
      () => createToolContext(),
    );

    expect(Object.keys(result.tools)).toEqual(
      expect.arrayContaining([
        'detect_db_engine',
        'get_top_slow_queries',
        'explain_query_plan',
        'compare_query_rewrite',
        'get_statistics_health',
        'validate_remediation_in_gfs_cli',
        'runQuery',
        'runQueries',
      ]),
    );

    expect(result.tools).not.toHaveProperty('todowrite');
    expect(result.tools).not.toHaveProperty('todoread');
  });

  it('keeps optimization-only tools out of ask and query agents', async () => {
    const optimizerOnlyTools = [
      'detect_db_engine',
      'get_top_slow_queries',
      'explain_query_plan',
      'compare_query_rewrite',
      'get_statistics_health',
      'validate_remediation_in_gfs_cli',
    ];

    const [queryTools, askTools] = await Promise.all([
      Registry.tools.forAgent(QueryAgent.id, MODEL, () => createToolContext()),
      Registry.tools.forAgent(AskAgent.id, MODEL, () => createToolContext()),
    ]);

    for (const toolId of optimizerOnlyTools) {
      expect(queryTools.tools).not.toHaveProperty(toolId);
      expect(askTools.tools).not.toHaveProperty(toolId);
    }
  });
});
