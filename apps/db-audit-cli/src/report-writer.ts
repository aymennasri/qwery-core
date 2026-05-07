import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { redactUrl } from './safety';

export type ReportInput = {
  url: string;
  dumpPath: string;
  statementTimeout: string;
  maxPlanCandidates: number;
  maxValidations: number;
  markdown?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

export async function writeReports(input: ReportInput, markdownPath: string, jsonPath?: string): Promise<void> {
  const markdownTarget = resolve(markdownPath);
  await mkdir(dirname(markdownTarget), { recursive: true });
  await writeFile(markdownTarget, input.markdown ?? markdownReport(input), 'utf8');

  if (jsonPath) {
    const jsonTarget = resolve(jsonPath);
    await mkdir(dirname(jsonTarget), { recursive: true });
    await writeFile(jsonTarget, `${JSON.stringify(jsonReport(input), null, 2)}\n`, 'utf8');
  }
}

function markdownReport(input: ReportInput): string {
  return `# PostgreSQL Audit Report\n\n## Context\n\n- Datasource: ${redactUrl(input.url)}\n- Prepared dump: ${input.dumpPath}\n- Statement timeout: ${input.statementTimeout}\n- Max plan candidates: ${input.maxPlanCandidates}\n- Max validations: ${input.maxValidations}\n\n## Safety Guarantee\n\nThe original database was not dumped or mutated by this CLI. Remediation SQL is reserved for GFS sandbox validation.\n\n## Status\n\nThe standalone CLI shell is installed and validated. Full agent runtime execution is not wired in this package yet.\n`;
}

function jsonReport(input: ReportInput): Record<string, unknown> {
  return {
    context: {
      datasource: redactUrl(input.url),
      dumpPath: input.dumpPath,
      statementTimeout: input.statementTimeout,
      maxPlanCandidates: input.maxPlanCandidates,
      maxValidations: input.maxValidations,
    },
    safety: {
      originalDatabaseUnchanged: true,
      automaticPgDump: false,
      remediationRunsInGfsOnly: true,
    },
    findings: [],
    recommendations: [],
    validationResults: [],
    usage: input.usage,
    caveats: input.markdown
      ? []
      : ['Full db-performance-audit agent runtime is not wired in this package yet.'],
  };
}
