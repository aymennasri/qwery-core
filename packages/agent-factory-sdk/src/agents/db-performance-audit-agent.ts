import { Agent } from './agent';
import { DB_PERFORMANCE_AUDIT_PROMPT } from './prompts/db-performance-audit.prompt';

export const DbPerformanceAuditAgent = Agent.define('db-performance-audit', {
  name: 'DB Audit',
  description:
    'Database performance audit agent focused on latency-impact findings and measured validation.',
  mode: 'main',
  steps: 80,
  options: {
    tools: {
      '*': false,
      detect_db_engine: true,
      get_top_slow_queries: true,
      explain_query_plan: true,
      get_index_health: true,
      get_table_health: true,
      get_infra_runtime_signals: true,
      get_recent_db_logs: true,
      get_lock_and_blocking_analysis: true,
      get_statistics_health: true,
      get_bloat_estimates: true,
      get_replication_health: true,
      validate_remediation_in_gfs_cli: true,
      runQuery: true,
      runQueries: true,
      todowrite: true,
      todoread: true,
    },
  },
  systemPrompt: DB_PERFORMANCE_AUDIT_PROMPT,
});
