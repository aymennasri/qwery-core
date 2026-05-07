import { stringFlag } from '../args';
import { CliError } from '../cli-error';
import { resolveDump } from '../dump';
import { runDbPerformanceAudit } from '../local-runtime';
import { writeReports } from '../report-writer';

export async function runAudit(flags: Record<string, string | boolean>): Promise<void> {
  if (flags.help) {
    printAuditHelp();
    return;
  }

  const url = stringFlag(flags, 'url');
  if (!url) throw new CliError('Missing required --url <postgres-url>.');

  const dumpResolution = await resolveDump({
    url,
    dump: stringFlag(flags, 'dump'),
    dumpDir: stringFlag(flags, 'dump-dir'),
  });

  Object.assign(process.env, dumpResolution.env);
  if (stringFlag(flags, 'gfs-audits-dir')) {
    process.env.QWERY_GFS_AUDITS_DIR = stringFlag(flags, 'gfs-audits-dir');
  }

  const markdownPath = stringFlag(flags, 'out') ?? defaultReportPath();
  const jsonPath = stringFlag(flags, 'json');
  const statementTimeout = stringFlag(flags, 'statement-timeout') ?? '30s';
  const maxPlanCandidates = numberFlag(flags, 'max-plan-candidates', 3);
  const maxValidations = numberFlag(flags, 'max-validations', 3);

  console.log('Resolved prepared dump for GFS validation.');
  console.log('Running db-performance-audit agent.');

  const result = await runDbPerformanceAudit({
    url,
    model: stringFlag(flags, 'model'),
    statementTimeout,
    maxPlanCandidates,
    maxValidations,
    onToolMetadata: (metadata) => {
      if (flags['debug-trace']) return;
      const name = toolNameFromMetadata(metadata);
      if (name) console.log(`Tool: ${name}`);
    },
  });

  await writeReports(
    {
      url,
      dumpPath: dumpResolution.selected ?? '',
      statementTimeout,
      maxPlanCandidates,
      maxValidations,
      markdown: result.text,
      usage: result.usage,
    },
    markdownPath,
    jsonPath,
  );

  console.log(`Audit report written to ${markdownPath}`);
}

function printAuditHelp(): void {
  console.log(`Usage: db-audit audit --url <postgres-url> (--dump <path> | --dump-dir <path>) [--out report.md] [--json report.json]\n\nMaps dump flags to QWERY_GFS_DUMP_FILE/QWERY_GFS_DUMPS_DIR and writes redacted audit artifacts.`);
}

function numberFlag(flags: Record<string, string | boolean>, name: string, fallback: number): number {
  const value = stringFlag(flags, name);
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new CliError(`--${name} must be a positive integer.`);
  }
  return parsed;
}

function defaultReportPath(): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `./db-audit-output/${timestamp}/report.md`;
}

function toolNameFromMetadata(metadata: unknown): string | undefined {
  if (typeof metadata !== 'object' || metadata === null) return undefined;
  const value = (metadata as { toolName?: unknown; tool?: unknown; name?: unknown }).toolName ??
    (metadata as { toolName?: unknown; tool?: unknown; name?: unknown }).tool ??
    (metadata as { toolName?: unknown; tool?: unknown; name?: unknown }).name;
  return typeof value === 'string' ? value : undefined;
}
