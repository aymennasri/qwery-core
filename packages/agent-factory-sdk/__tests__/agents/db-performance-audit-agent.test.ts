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

  it('keeps enough step budget and todo tooling for multi-phase audits', () => {
    const tools = DbPerformanceAuditAgent.options?.tools as
      | Record<string, boolean>
      | undefined;

    expect(DbPerformanceAuditAgent.steps).toBeGreaterThanOrEqual(60);
    expect(tools?.todowrite).toBe(true);
    expect(tools?.todoread).toBe(true);
  });

  it('instructs the agent to report measured before and after testing', () => {
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'If no datasource is attached, stop immediately',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'When `validate_remediation_in_gfs_cli` is available',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'before metrics, after metrics, and a delta statement',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'Recommendation Testing Results',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'validate every solution in GFS',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'default to testing ANALYZE on the most relevant table in GFS',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'Prefer reversible experiments before persistent changes',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'SET LOCAL or SET for the current session',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'provide only remediation alternatives that were executed in GFS',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'Use the original datasource only for read-only diagnostics and evidence gathering',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'after commit',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      '| Recommendation | GFS Branch | Checkpoint Commit | Action Taken | Before | After | Delta | Rollback | Outcome |',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'Audit incomplete: not all solutions could be executed in GFS.',
    );
    expect(DB_PERFORMANCE_AUDIT_PROMPT).toContain(
      'The Recommendation Testing Results table must contain only executed GFS validations',
    );
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
        'todowrite',
        'todoread',
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
