import { Agent } from './agent';
import { BASE_AGENT_PROMPT } from './prompts/base-agent.prompt';
import { FINAL_ANSWER_PROMPT } from './prompts/final-answer.prompt';

export const QueryAgent = Agent.define('query', {
  name: 'Query',
  description: 'Data and query-focused agent for executing and analyzing data.',
  mode: 'main',
  steps: 100,
  options: {
    toolDenylist: [
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
    ],
  },
  systemPrompt: [BASE_AGENT_PROMPT, FINAL_ANSWER_PROMPT].join('\n\n'),
});
