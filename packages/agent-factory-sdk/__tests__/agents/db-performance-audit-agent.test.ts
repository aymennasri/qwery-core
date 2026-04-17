import { describe, expect, it } from 'vitest';
import { AskAgent } from '../../src/agents/ask-agent';
import { DbPerformanceAuditAgent } from '../../src/agents/db-performance-audit-agent';
import { QueryAgent } from '../../src/agents/query-agent';
import { DB_PERFORMANCE_AUDIT_PROMPT } from '../../src/agents/prompts/db-performance-audit.prompt';
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

describe('DbPerformanceAuditAgent', () => {
  it('exposes the audit diagnostics tool allowlist', () => {
    const tools = DbPerformanceAuditAgent.options?.tools as
      | Record<string, boolean>
      | undefined;

    expect(tools).toBeDefined();
    expect(tools?.detect_db_engine).toBe(true);
    expect(tools?.get_recent_db_logs).toBe(true);
    expect(tools?.get_lock_and_blocking_analysis).toBe(true);
    expect(tools?.get_statistics_health).toBe(true);
    expect(tools?.get_bloat_estimates).toBe(true);
    expect(tools?.get_replication_health).toBe(true);
    expect(tools?.validate_remediation_in_gfs_cli).toBe(true);
    expect(tools?.get_top_slow_queries).toBe(true);
    expect(tools?.explain_query_plan).toBe(true);
    expect(tools?.runQuery).toBe(true);
    expect(tools?.runQueries).toBe(true);
  });

  it('keeps enough step budget for multi-phase audits without todo tools', () => {
    expect(DbPerformanceAuditAgent.steps).toBeGreaterThanOrEqual(60);
    expect(DB_PERFORMANCE_AUDIT_PROMPT).not.toContain('keep task progress visible with todo tools');
    expect(DB_PERFORMANCE_AUDIT_PROMPT).not.toContain('track with todo tools');
  });

  it('instructs the agent to report measured before and after testing', () => {
    const requiredPhrases = [
      'If no datasource is attached, stop immediately',
      'validate performance-affecting solutions in GFS',
      'before metrics, after metrics, and a delta statement',
      'Recommendation Testing Results',
      'default to testing ANALYZE on the most relevant table in GFS',
      'Prefer reversible experiments before persistent changes',
      'Place `SET LOCAL`/`SET` and `RESET` statements in `actionStatements`',
      'validationQuery` must stay a read-only representative `SELECT` or `WITH` query',
      'Never batch multiple `validate_remediation_in_gfs_cli` calls in the same assistant turn',
      'Use the original datasource only for read-only diagnostics and evidence gathering',
      '| Recommendation | Validation Type | GFS Branch | Checkpoint Commit | Action Taken | Before | After | Delta | Rollback | Outcome |',
      'Audit incomplete: not all solutions could be executed in GFS.',
      'The Recommendation Testing Results table must contain only executed GFS validations',
      'validation.assessment as authoritative',
      'Do not promote a regressed or neutral GFS result into the executive summary, quick wins, or conclusion',
      'If a validation benchmark is below 5ms total time before the change',
      'If a tested candidate was rejected or inconclusive, do not include it as a recommendation row',
      'Only include performance-affecting actions with successful GFS validation and recommendationStatus `validated`',
      'Do not include any performance-affecting suggested action anywhere in the final report',
      'For performance-affecting configuration actions, you must still validate in GFS',
      'For observability-only changes, do not force a GFS validation',
      'build a validated recommendation registry from successful GFS validations for performance-affecting actions',
      'Blocked - no validated GFS remediation for this finding.',
      'The only performance-affecting actions allowed in Sections 3, 4, 7, 10, 11, and 12 are the actions present in the successful GFS validation set',
      'Observability-only actions may be mentioned as recommendations when they are supported directly by collected evidence',
      'If fewer than 3 validated performance-affecting actions exist, list only those plus any direct evidence-backed observability quick wins.',
      'Do not mention any performance-affecting next action in the conclusion unless it appears in the successful GFS validation set.',
    ];

    for (const phrase of requiredPhrases) {
      expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(phrase);
    }
  });

  it('registers every required db audit tool for the audit agent', async () => {
    const result = await Registry.tools.forAgent(
      DbPerformanceAuditAgent.id,
      MODEL,
      () => createToolContext(),
    );

    expect(Object.keys(result.tools)).toEqual(
      expect.arrayContaining([
        'detect_db_engine',
        'get_top_slow_queries',
        'explain_query_plan',
        'get_index_health',
        'get_table_health',
        'get_infra_runtime_signals',
        'get_recent_db_logs',
        'get_lock_and_blocking_analysis',
        'get_statistics_health',
        'get_bloat_estimates',
        'get_replication_health',
        'validate_remediation_in_gfs_cli',
        'runQuery',
        'runQueries',
      ]),
    );
  });

  it('keeps audit-only tools out of ask and query agents', async () => {
    const auditOnlyTools = [
      'detect_db_engine',
      'get_top_slow_queries',
      'explain_query_plan',
      'get_index_health',
      'get_table_health',
      'get_infra_runtime_signals',
      'get_recent_db_logs',
      'get_lock_and_blocking_analysis',
      'get_statistics_health',
      'get_bloat_estimates',
      'get_replication_health',
      'validate_remediation_in_gfs_cli',
    ];

    const [queryTools, askTools] = await Promise.all([
      Registry.tools.forAgent(QueryAgent.id, MODEL, () => createToolContext()),
      Registry.tools.forAgent(AskAgent.id, MODEL, () => createToolContext()),
    ]);

    for (const toolId of auditOnlyTools) {
      expect(queryTools.tools).not.toHaveProperty(toolId);
      expect(askTools.tools).not.toHaveProperty(toolId);
    }
  });
});
