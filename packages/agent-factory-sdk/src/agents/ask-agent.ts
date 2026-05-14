import { Agent } from './agent';

export const AskAgent = Agent.define('ask', {
  name: 'Ask',
  description:
    'General-purpose agent for questions and conversational assistance.',
  mode: 'main',
  steps: 100,
  options: {
    toolDenylist: [
      'detect_db_engine',
      'get_top_slow_queries',
      'explain_query_plan',
      'compare_query_rewrite',
      'get_index_health',
      'get_table_health',
      'get_infra_runtime_signals',
      'get_recent_db_logs',
      'get_lock_and_blocking_analysis',
      'get_statistics_health',
      'get_bloat_estimates',
      'get_replication_health',
      'validate_remediation_in_gfs',
      'validate_remediation_in_gfs_cli',
    ],
  },
});
