import { Agent } from './agent';
import { SLOW_QUERY_OPTIMIZER_PROMPT } from './prompts/slow-query-optimizer.prompt';

export const SlowQueryOptimizerAgent = Agent.define('slow-query-optimizer', {
  name: 'Query Optimizer',
  description:
    'Focused slow-query optimization agent for reproducing hotspots and validating fixes in GFS.',
  mode: 'main',
  steps: 70,
  options: {
    tools: {
      '*': false,
      detect_db_engine: true,
      get_top_slow_queries: true,
      explain_query_plan: true,
      compare_query_rewrite: true,
      get_statistics_health: true,
      validate_remediation_in_gfs_cli: true,
      runQuery: true,
      runQueries: true,
    },
  },
  systemPrompt: SLOW_QUERY_OPTIMIZER_PROMPT,
});
