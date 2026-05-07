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
      db_audit_diagnostics: true,
      db_audit_plan: true,
      validate_remediation_in_gfs_cli: true,
      runQuery: true,
      runQueries: true,
    },
  },
  systemPrompt: DB_PERFORMANCE_AUDIT_PROMPT,
});
