import { execFile, type ExecFileException } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { extractConnectionUrl } from '@qwery/extensions-sdk';
import { getLogger } from '@qwery/shared/logger';
import { Tool } from './tool';
import {
  assertExplainTargetSql,
  isPostgresDatasource,
  resolveAttachedDatasource,
} from './db-audit/shared';

const DESCRIPTION = `Clone the attached PostgreSQL datasource into a temporary GFS repository using the GFS CLI, create an isolated audit branch, run before/after EXPLAIN ANALYZE measurements around remediation SQL, and return the branch, commits, metrics, and rollback commands. Use this when a recommendation should be validated safely away from the original datasource.`;

const MAX_ACTIONS = 10;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const PG_DUMP_TIMEOUT_MS = 30 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 30 * 1000;
const COMPUTE_STOP_TIMEOUT_MS = 30 * 1000;
const POSTGRES_READY_TIMEOUT_MS = 60 * 1000;
const POSTGRES_READY_RETRY_DELAY_MS = 1000;
const POSTGRES_READY_CHECK_TIMEOUT_MS = 5000;
const GFS_AUDIT_ROOT_ENV_VAR = 'QWERY_GFS_AUDITS_DIR';
const GFS_AUDIT_ROOT_SUBDIR = 'qwery/gfs-audits';
const GFS_BASELINE_CACHE_SUBDIR = 'baselines';
const GFS_VALIDATION_RUNS_SUBDIR = 'runs';
const GFS_BASELINE_METADATA_FILENAME = 'baseline.json';
const GFS_BASELINE_BUILD_SUFFIX = '.building';
const GFS_BASELINE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const GFS_BASELINE_LOCK_STALE_MS = 15 * 60 * 1000;
const GFS_BASELINE_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const GFS_BASELINE_LOCK_WAIT_STEP_MS = 500;
const GFS_BASELINE_LOCK_METADATA_FILENAME = 'owner.json';
const MIN_LATENCY_IMPACT_BENCHMARK_MS = 5;
const NEUTRAL_DELTA_ABS_MS = 1;
const NEUTRAL_DELTA_PCT = 10;
const inProcessValidationQueues = new Map<string, Promise<void>>();
const POSTGRES_CLIENT_ENV_VARS = {
  psql: 'QWERY_PSQL_BIN',
  pgDump: 'QWERY_PG_DUMP_BIN',
} as const;
const COMMON_POSTGRES_MAJOR_VERSIONS = ['18', '17', '16', '15', '14', '13'];

type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type CommandResult = {
  stdout: string;
  stderr: string;
};

type DirectoryLockMetadata = {
  pid: number;
  createdAt: string;
};

type ExplainMetrics = {
  planningTimeMs: number;
  executionTimeMs: number;
  totalTimeMs: number;
};

type ExplainPlanSummary = {
  rootNodeType: string;
  relationName: string | null;
  indexName: string | null;
  planRows: number | null;
  actualRows: number | null;
  sharedHitBlocks: number | null;
  sharedReadBlocks: number | null;
};

type ExplainAnalysis = ExplainMetrics & {
  plan: ExplainPlanSummary;
};

type ValidationAssessment = {
  timingOutcome: 'improved' | 'regressed' | 'neutral';
  recommendationStatus: 'validated' | 'rejected' | 'inconclusive';
  benchmarkSuitability: 'latency-impact' | 'low-latency' | 'non-latency';
  rationale: string;
  cautions: string[];
};

type GfsStatusResponse = {
  current_branch: string;
  compute?: {
    connection_string: string;
  } | null;
};

type GfsLogResponse = {
  commits?: Array<{
    hash?: string;
    hash_full?: string;
  }>;
};

type ResolvedPostgresClientBinaries = {
  psql: string;
  pgDump: string;
  majorVersion: string;
};

type GfsBaselineMetadata = {
  state: 'building' | 'ready' | 'failed';
  checkpointCommit: string;
  postgresMajorVersion: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
};

type EnsuredGfsBaseline = {
  cacheDir: string;
  repoPath: string;
  checkpointCommit: string;
  postgresMajorVersion: string;
  psqlBinary: string;
  pgDumpBinary: string | null;
  reused: boolean;
  computeRunning: boolean;
};

type IsolatedValidationRepo = {
  workingDir: string;
  repoPath: string;
};

type PartitionedActionStatements = {
  persistentStatements: string[];
  sessionSetupStatements: string[];
  sessionTeardownStatements: string[];
};

type DirectoryLockOptions = {
  waitOnBusy?: boolean;
  busyMessage?: string;
};

type StageLoggerInput = {
  logger: Awaited<ReturnType<typeof getLogger>>;
  stage: string;
  message: string;
  metadata?: Record<string, unknown>;
};

function logValidationStage(input: StageLoggerInput): void {
  input.logger.info(
    {
      stage: input.stage,
      ...(input.metadata ?? {}),
    },
    input.message,
  );
}

function sanitizeBranchName(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);

  if (!sanitized) {
    throw new Error(
      'Branch name must contain at least one alphanumeric character.',
    );
  }

  return sanitized;
}

function normalizeActionStatement(statement: string): string {
  const normalized = statement.trim().replace(/;\s*$/, '');
  if (!normalized) {
    throw new Error('Each action statement must be a non-empty SQL statement.');
  }

  if (normalized.includes(';')) {
    throw new Error(
      'Provide exactly one SQL statement per actionStatements item.',
    );
  }

  return normalized;
}

function buildExplainSql(query: string): string {
  const trimmed = query.trim().replace(/;\s*$/, '');
  return `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${trimmed}`;
}

function isSessionSetupStatement(statement: string): boolean {
  return /^SET(?:\s+LOCAL|\s+SESSION)?\b/i.test(statement);
}

function isSessionTeardownStatement(statement: string): boolean {
  return /^RESET(?:\s+ALL)?\b/i.test(statement);
}

function partitionActionStatements(
  actionStatements: string[],
): PartitionedActionStatements {
  const persistentStatements: string[] = [];
  const sessionSetupStatements: string[] = [];
  const sessionTeardownStatements: string[] = [];

  for (const statement of actionStatements) {
    if (isSessionTeardownStatement(statement)) {
      sessionTeardownStatements.push(statement);
      continue;
    }

    if (isSessionSetupStatement(statement)) {
      sessionSetupStatements.push(statement);
      continue;
    }

    persistentStatements.push(statement);
  }

  return {
    persistentStatements,
    sessionSetupStatements,
    sessionTeardownStatements,
  };
}

function buildSessionScopedExplainSql(input: {
  validationQuery: string;
  sessionSetupStatements: string[];
  sessionTeardownStatements: string[];
}): string {
  const needsTransaction = input.sessionSetupStatements.some((statement) =>
    /^SET\s+LOCAL\b/i.test(statement),
  );
  const statements = [
    ...(needsTransaction ? ['BEGIN'] : []),
    ...input.sessionSetupStatements,
    buildExplainSql(input.validationQuery),
    ...input.sessionTeardownStatements,
    ...(needsTransaction ? ['COMMIT'] : []),
  ];

  return statements
    .map((statement) => statement.trim().replace(/;\s*$/, ''))
    .join(';\n');
}

function extractExplainJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('EXPLAIN ANALYZE returned no output.');
  }

  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed;
  }

  const firstBracket = trimmed.indexOf('[');
  const lastBracket = trimmed.lastIndexOf(']');
  if (firstBracket === -1 || lastBracket === -1 || lastBracket < firstBracket) {
    throw new Error('EXPLAIN ANALYZE output did not include JSON payload.');
  }

  return trimmed.slice(firstBracket, lastBracket + 1);
}

function parseExplainRoot(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(extractExplainJsonPayload(raw)) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('EXPLAIN ANALYZE JSON output was not an array.');
  }

  const root = parsed[0];
  if (typeof root !== 'object' || root === null) {
    throw new Error('EXPLAIN ANALYZE JSON output was malformed.');
  }

  return root as Record<string, unknown>;
}

function parseExplainMetrics(raw: string): ExplainMetrics {
  const root = parseExplainRoot(raw);

  const planningTime = Number(root['Planning Time'] ?? 0);
  const executionTime = Number(root['Execution Time'] ?? 0);

  if (!Number.isFinite(planningTime) || !Number.isFinite(executionTime)) {
    throw new Error('EXPLAIN ANALYZE did not include numeric timing metrics.');
  }

  return {
    planningTimeMs: planningTime,
    executionTimeMs: executionTime,
    totalTimeMs: planningTime + executionTime,
  };
}

function parseExplainPlanSummary(raw: string): ExplainPlanSummary {
  const root = parseExplainRoot(raw);
  const plan = root['Plan'];
  if (typeof plan !== 'object' || plan === null) {
    throw new Error('EXPLAIN ANALYZE did not include a plan node.');
  }

  const planNode = plan as Record<string, unknown>;
  const numberOrNull = (value: unknown): number | null => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const stringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value : null;

  return {
    rootNodeType: stringOrNull(planNode['Node Type']) ?? 'Unknown',
    relationName: stringOrNull(planNode['Relation Name']),
    indexName: stringOrNull(planNode['Index Name']),
    planRows: numberOrNull(planNode['Plan Rows']),
    actualRows: numberOrNull(planNode['Actual Rows']),
    sharedHitBlocks: numberOrNull(planNode['Shared Hit Blocks']),
    sharedReadBlocks: numberOrNull(planNode['Shared Read Blocks']),
  };
}

function parseExplainAnalysis(raw: string): ExplainAnalysis {
  return {
    ...parseExplainMetrics(raw),
    plan: parseExplainPlanSummary(raw),
  };
}

type ValidationType = 'latency' | 'config' | 'maintenance';

function assessValidationResult(
  before: ExplainAnalysis,
  after: ExplainAnalysis,
  validationType: ValidationType,
  actionStatements: string[],
): ValidationAssessment {
  const cautions: string[] = [];

  if (validationType === 'config') {
    return assessConfigValidation(before, after, actionStatements, cautions);
  }

  if (validationType === 'maintenance') {
    return assessMaintenanceValidation(before, after, actionStatements, cautions);
  }

  return assessLatencyValidation(before, after, cautions);
}

function assessLatencyValidation(
  before: ExplainAnalysis,
  after: ExplainAnalysis,
  cautions: string[],
): ValidationAssessment {
  const totalDeltaMs = after.totalTimeMs - before.totalTimeMs;
  const deltaPct =
    before.totalTimeMs > 0 ? (totalDeltaMs / before.totalTimeMs) * 100 : null;
  const isNeutralByAbs = Math.abs(totalDeltaMs) < NEUTRAL_DELTA_ABS_MS;
  const isNeutralByPct =
    deltaPct !== null && Math.abs(deltaPct) < NEUTRAL_DELTA_PCT;
  const timingOutcome: ValidationAssessment['timingOutcome'] =
    isNeutralByAbs || isNeutralByPct
      ? 'neutral'
      : totalDeltaMs < 0
        ? 'improved'
        : 'regressed';
  const benchmarkSuitability: ValidationAssessment['benchmarkSuitability'] =
    before.totalTimeMs >= MIN_LATENCY_IMPACT_BENCHMARK_MS
      ? 'latency-impact'
      : 'low-latency';

  if (benchmarkSuitability === 'low-latency') {
    cautions.push(
      `Benchmark total time before the change was under ${MIN_LATENCY_IMPACT_BENCHMARK_MS}ms; do not frame this as a user-facing latency-impact finding without a slower representative query.`,
    );
  }

  const readBlocksBefore = before.plan.sharedReadBlocks ?? 0;
  const readBlocksAfter = after.plan.sharedReadBlocks ?? 0;
  const hitBlocksBefore = before.plan.sharedHitBlocks ?? 0;
  const hitBlocksAfter = after.plan.sharedHitBlocks ?? 0;
  const ioReduced = readBlocksAfter < readBlocksBefore && readBlocksBefore > 0;

  if (timingOutcome === 'improved') {
    const ioNote = ioReduced
      ? ` I/O dropped from ${readBlocksBefore} to ${readBlocksAfter} read blocks.`
      : '';
    const rootChanged =
      before.plan.rootNodeType !== after.plan.rootNodeType;
    const rootNote = rootChanged
      ? ` and shifted the root plan node from ${before.plan.rootNodeType} to ${after.plan.rootNodeType}`
      : '';
    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale: `The tested change improved the representative benchmark by ${Math.abs(deltaPct ?? 0).toFixed(1)}%${rootNote}.${ioNote}`,
      cautions,
    };
  }

  if (timingOutcome === 'neutral' && ioReduced) {
    const hitIncrease = hitBlocksAfter - hitBlocksBefore;
    return {
      timingOutcome: 'neutral',
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale: `While timing was neutral (likely due to caching), I/O dropped from ${readBlocksBefore} to ${readBlocksAfter} read blocks (${hitIncrease > 0 ? `+${hitIncrease} cache hits` : 'reduced disk reads'}). This change will improve performance under realistic cache pressure.`,
      cautions: [
        ...cautions,
        'Timing was neutral in this warm-cache run; the benefit will be visible under cache pressure or cold starts.',
      ],
    };
  }

  if (timingOutcome === 'regressed') {
    cautions.push(
      'This tested change regressed the representative benchmark. Do not present it as a quick win or confirmed production fix for this workload.',
    );
    return {
      timingOutcome,
      recommendationStatus: 'rejected',
      benchmarkSuitability,
      rationale: `The tested change made the representative benchmark slower, from ${before.totalTimeMs.toFixed(3)}ms to ${after.totalTimeMs.toFixed(3)}ms total time.`,
      cautions,
    };
  }

  cautions.push(
    'The measured delta fell within the neutral threshold; treat this as inconclusive unless repeated benchmarks show a consistent change.',
  );
  return {
    timingOutcome,
    recommendationStatus: 'inconclusive',
    benchmarkSuitability,
    rationale:
      'The tested change did not produce a material timing difference on the representative benchmark.',
    cautions,
  };
}

function assessConfigValidation(
  before: ExplainAnalysis,
  after: ExplainAnalysis,
  actionStatements: string[],
  cautions: string[],
): ValidationAssessment {
  const totalDeltaMs = after.totalTimeMs - before.totalTimeMs;
  const deltaPct =
    before.totalTimeMs > 0 ? (totalDeltaMs / before.totalTimeMs) * 100 : null;
  const isNeutralByAbs = Math.abs(totalDeltaMs) < NEUTRAL_DELTA_ABS_MS;
  const isNeutralByPct =
    deltaPct !== null && Math.abs(deltaPct) < NEUTRAL_DELTA_PCT;
  const timingOutcome: ValidationAssessment['timingOutcome'] =
    isNeutralByAbs || isNeutralByPct
      ? 'neutral'
      : totalDeltaMs < 0
        ? 'improved'
        : 'regressed';

  const readBlocksBefore = before.plan.sharedReadBlocks ?? 0;
  const readBlocksAfter = after.plan.sharedReadBlocks ?? 0;
  const hitBlocksBefore = before.plan.sharedHitBlocks ?? 0;
  const hitBlocksAfter = after.plan.sharedHitBlocks ?? 0;
  const ioReduced = readBlocksAfter < readBlocksBefore && readBlocksBefore > 0;

  const hasSetAction = actionStatements.some(
    (s) => /^\s*SET\s+(LOCAL\s+)?/i.test(s),
  );
  const hasAlterAction = actionStatements.some(
    (s) => /^\s*ALTER\s+(SYSTEM\s+)?/i.test(s),
  );
  const hasResetAction = actionStatements.some(
    (s) => /^\s*RESET\s+/i.test(s),
  );

  if (hasSetAction || hasAlterAction) {
    if (ioReduced) {
      return {
        timingOutcome: timingOutcome === 'improved' ? 'improved' : 'neutral',
        recommendationStatus: 'validated',
        benchmarkSuitability: 'non-latency',
        rationale: `The configuration change took effect and reduced I/O from ${readBlocksBefore} to ${readBlocksAfter} read blocks. The setting is active and producing measurable impact.`,
        cautions: hasResetAction
          ? [...cautions, 'The setting was reset after the experiment; apply persistently via ALTER SYSTEM for production use.']
          : cautions,
      };
    }

    if (timingOutcome === 'improved') {
      return {
        timingOutcome,
        recommendationStatus: 'validated',
        benchmarkSuitability: 'non-latency',
        rationale: `The configuration change took effect and improved query timing by ${Math.abs(deltaPct ?? 0).toFixed(1)}%.`,
        cautions: hasResetAction
          ? [...cautions, 'The setting was reset after the experiment; apply persistently via ALTER SYSTEM for production use.']
          : cautions,
      };
    }

    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability: 'non-latency',
      rationale: `The configuration change was applied successfully in GFS. The setting is active and the experiment completed without errors.`,
      cautions: [
        ...cautions,
        'This is a configuration validation, not a latency benchmark. The setting change does not produce measurable timing impact on this query shape but is still recommended based on observed symptoms.',
        hasResetAction
          ? 'The setting was reset after the experiment; apply persistently via ALTER SYSTEM for production use.'
          : '',
      ].filter(Boolean),
    };
  }

  return {
    timingOutcome: 'neutral',
    recommendationStatus: 'inconclusive',
    benchmarkSuitability: 'non-latency',
    rationale: 'Could not determine the type of configuration action. Ensure actionStatements includes SET, ALTER SYSTEM, or similar configuration changes.',
    cautions: [...cautions, 'Unknown action type for config validation.'],
  };
}

function assessMaintenanceValidation(
  before: ExplainAnalysis,
  after: ExplainAnalysis,
  actionStatements: string[],
  cautions: string[],
): ValidationAssessment {
  const totalDeltaMs = after.totalTimeMs - before.totalTimeMs;
  const deltaPct =
    before.totalTimeMs > 0 ? (totalDeltaMs / before.totalTimeMs) * 100 : null;
  const isNeutralByAbs = Math.abs(totalDeltaMs) < NEUTRAL_DELTA_ABS_MS;
  const isNeutralByPct =
    deltaPct !== null && Math.abs(deltaPct) < NEUTRAL_DELTA_PCT;
  const timingOutcome: ValidationAssessment['timingOutcome'] =
    isNeutralByAbs || isNeutralByPct
      ? 'neutral'
      : totalDeltaMs < 0
        ? 'improved'
        : 'regressed';

  const benchmarkSuitability: ValidationAssessment['benchmarkSuitability'] =
    before.totalTimeMs >= MIN_LATENCY_IMPACT_BENCHMARK_MS
      ? 'latency-impact'
      : 'low-latency';

  const readBlocksBefore = before.plan.sharedReadBlocks ?? 0;
  const readBlocksAfter = after.plan.sharedReadBlocks ?? 0;
  const hitBlocksBefore = before.plan.sharedHitBlocks ?? 0;
  const hitBlocksAfter = after.plan.sharedHitBlocks ?? 0;
  const ioReduced = readBlocksAfter < readBlocksBefore && readBlocksBefore > 0;

  const hasAnalyze = actionStatements.some(
    (s) => /^\s*ANALYZE\s/i.test(s),
  );
  const hasVacuum = actionStatements.some(
    (s) => /^\s*VACUUM\s/i.test(s),
  );
  const hasDropIndex = actionStatements.some(
    (s) => /^\s*DROP\s+INDEX\s/i.test(s),
  );

  if (hasAnalyze) {
    if (timingOutcome === 'improved') {
      return {
        timingOutcome,
        recommendationStatus: 'validated',
        benchmarkSuitability,
        rationale: `ANALYZE refreshed statistics and improved query timing by ${Math.abs(deltaPct ?? 0).toFixed(1)}%.`,
        cautions,
      };
    }

    if (ioReduced) {
      return {
        timingOutcome: 'neutral',
        recommendationStatus: 'validated',
        benchmarkSuitability,
        rationale: `ANALYZE refreshed statistics. While timing was neutral, I/O dropped from ${readBlocksBefore} to ${readBlocksAfter} read blocks, indicating improved plan choices.`,
        cautions: [...cautions, 'Timing was neutral in this run; the benefit may be more visible under different query patterns or cache conditions.'],
      };
    }

    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale: 'ANALYZE completed successfully. Statistics are now fresh. The timing impact on this specific query was minimal but the maintenance is still recommended.',
      cautions: [...cautions, 'No measurable timing improvement on this query; benefit may appear on other query shapes or after planner re-evaluation.'],
    };
  }

  if (hasVacuum) {
    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale: 'VACUUM completed successfully. Dead tuples reclaimed and statistics refreshed.',
      cautions,
    };
  }

  if (hasDropIndex) {
    if (timingOutcome === 'neutral' || timingOutcome === 'improved') {
      return {
        timingOutcome,
        recommendationStatus: 'validated',
        benchmarkSuitability,
        rationale: `Dropping the index did not regress query performance${timingOutcome === 'improved' ? ` and improved timing by ${Math.abs(deltaPct ?? 0).toFixed(1)}%` : ''}. The index is confirmed as safe to drop.`,
        cautions,
      };
    }

    return {
      timingOutcome,
      recommendationStatus: 'rejected',
      benchmarkSuitability,
      rationale: `Dropping the index regressed query timing from ${before.totalTimeMs.toFixed(3)}ms to ${after.totalTimeMs.toFixed(3)}ms. The index may be in use by other query patterns.`,
      cautions: [...cautions, 'Do not drop this index without testing all affected query patterns.'],
    };
  }

  if (timingOutcome === 'improved') {
    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale: `The maintenance action improved query timing by ${Math.abs(deltaPct ?? 0).toFixed(1)}%.`,
      cautions,
    };
  }

  if (timingOutcome === 'regressed') {
    return {
      timingOutcome,
      recommendationStatus: 'rejected',
      benchmarkSuitability,
      rationale: `The maintenance action regressed query timing from ${before.totalTimeMs.toFixed(3)}ms to ${after.totalTimeMs.toFixed(3)}ms.`,
      cautions: [...cautions, 'Do not present this as a confirmed fix.'],
    };
  }

  return {
    timingOutcome,
    recommendationStatus: 'validated',
    benchmarkSuitability,
    rationale: 'The maintenance action completed successfully without regression.',
    cautions: [...cautions, 'No measurable timing improvement; benefit may be operational rather than latency-related.'],
  };
}

function parseCommitHash(logOutput: string): string {
  const match = logOutput.match(/^commit\s+([0-9a-f]{7,64})\b/m);
  if (!match?.[1]) {
    throw new Error('Unable to parse the latest GFS commit hash.');
  }

  return match[1];
}

function isFullCommitHash(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value.trim());
}

function parseLatestCommitHashFromGfsLogJson(raw: string): string {
  const parsed = JSON.parse(raw) as GfsLogResponse;
  const latestCommit = parsed.commits?.[0];
  if (!latestCommit) {
    throw new Error('GFS log did not return any commits.');
  }

  const fullHash = latestCommit.hash_full?.trim();
  if (fullHash && isFullCommitHash(fullHash)) {
    return fullHash;
  }

  const hash = latestCommit.hash?.trim();
  if (hash && /^[0-9a-f]{7,64}$/i.test(hash)) {
    return hash;
  }

  throw new Error('Unable to parse the latest GFS commit hash from JSON log output.');
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== '')));
}

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (
    code === 'EACCES' ||
    code === 'EPERM' ||
    code === 'EROFS' ||
    code === 'EBUSY'
  );
}

function isRetryablePostgresStartupError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('the database system is starting up') ||
    message.includes('connection refused') ||
    message.includes('could not connect to server') ||
    message.includes('server closed the connection unexpectedly') ||
    message.includes('connection to server was lost') ||
    message.includes('terminating connection due to administrator command') ||
    message.includes('the database server shut down unexpectedly')
  );
}

function isExistingBranchError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /branch\s+['`"]?.+['`"]?\s+already exists/i.test(error.message)
  );
}

async function waitForAbortableDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error('Operation aborted.');
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);

    function onAbort(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Operation aborted.'),
      );
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function resolveGfsAuditWorkingRoot(): string {
  const configuredRoot = process.env[GFS_AUDIT_ROOT_ENV_VAR]?.trim();
  if (configuredRoot) {
    return configuredRoot;
  }

  const home = homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(base, GFS_AUDIT_ROOT_SUBDIR);
  }

  const base = process.env.XDG_CACHE_HOME ?? join(home, '.cache');
  return join(base, GFS_AUDIT_ROOT_SUBDIR);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function buildBaselineCacheKey(input: {
  datasourceId: string;
  connectionUrl: string;
}): string {
  return `${input.datasourceId}-${hashText(input.connectionUrl)}`;
}

function buildBaselineStagingCacheDir(cacheDir: string): string {
  return `${cacheDir}${GFS_BASELINE_BUILD_SUFFIX}-${randomUUID().slice(0, 8)}`;
}

function createBaselineMetadata(input: {
  state: GfsBaselineMetadata['state'];
  checkpointCommit?: string;
  postgresMajorVersion?: string;
  createdAt?: string;
  error?: string;
}): GfsBaselineMetadata {
  const now = new Date().toISOString();
  return {
    state: input.state,
    checkpointCommit: input.checkpointCommit ?? '',
    postgresMajorVersion: input.postgresMajorVersion ?? '',
    createdAt: input.createdAt ?? now,
    updatedAt: now,
    ...(input.error ? { error: input.error } : {}),
  };
}

function isReadyBaselineMetadata(
  metadata: GfsBaselineMetadata | null,
): metadata is GfsBaselineMetadata {
  return (
    metadata?.state === 'ready' &&
    metadata.checkpointCommit.trim().length > 0 &&
    metadata.postgresMajorVersion.trim().length > 0
  );
}

function buildBranchNameWithSuffix(branchName: string, suffix: string): string {
  const normalizedSuffix = sanitizeBranchName(suffix);
  const maxBranchBaseLength = 63 - normalizedSuffix.length - 1;
  const branchBase = branchName.slice(0, Math.max(1, maxBranchBaseLength));
  return sanitizeBranchName(`${branchBase}-${normalizedSuffix}`);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function withDirectoryLock<T>(
  lockDir: string,
  signal: AbortSignal,
  fn: () => Promise<T>,
  options: DirectoryLockOptions = {},
): Promise<T> {
  const startedAt = Date.now();
  const metadataPath = join(lockDir, GFS_BASELINE_LOCK_METADATA_FILENAME);

  while (Date.now() - startedAt < GFS_BASELINE_LOCK_WAIT_TIMEOUT_MS) {
    try {
      await mkdir(lockDir);
      await writeFile(
        metadataPath,
        JSON.stringify(
          {
            pid: process.pid,
            createdAt: new Date().toISOString(),
          } satisfies DirectoryLockMetadata,
          null,
          2,
        ),
        'utf8',
      ).catch(() => {
        // Best-effort metadata for cross-process orphan detection.
      });
      const heartbeat = setInterval(() => {
        const now = new Date();
        void writeFile(
          metadataPath,
          JSON.stringify(
            {
              pid: process.pid,
              createdAt: now.toISOString(),
            } satisfies DirectoryLockMetadata,
            null,
            2,
          ),
          'utf8',
        ).catch(() => undefined);
        void utimes(lockDir, now, now).catch(() => undefined);
      }, Math.max(1000, Math.floor(GFS_BASELINE_LOCK_STALE_MS / 3)));
      try {
        return await fn();
      } finally {
        clearInterval(heartbeat);
        await rm(lockDir, { recursive: true, force: true }).catch(() => {
          // Best-effort lock cleanup.
        });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'EEXIST') {
        throw error;
      }

      try {
        const owner = JSON.parse(
          await readFile(metadataPath, 'utf8'),
        ) as Partial<DirectoryLockMetadata>;
        const ownerPid =
          typeof owner.pid === 'number' && Number.isInteger(owner.pid)
            ? owner.pid
            : null;

        if (ownerPid !== null) {
          try {
            process.kill(ownerPid, 0);
          } catch {
            await rm(lockDir, { recursive: true, force: true });
            continue;
          }
        }

        const lockStat = await stat(metadataPath).catch(() => stat(lockDir));
        if (Date.now() - lockStat.mtimeMs > GFS_BASELINE_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock may have been released between stat attempts.
      }

      if (options.waitOnBusy === false) {
        throw new Error(
          options.busyMessage ??
            'Another operation is already using this cached GFS baseline.',
        );
      }

      await waitForAbortableDelay(GFS_BASELINE_LOCK_WAIT_STEP_MS, signal);
    }
  }

  throw new Error('Timed out waiting for the cached GFS baseline lock.');
}

async function withInProcessValidationQueue<T>(
  key: string,
  logger: Awaited<ReturnType<typeof getLogger>>,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = inProcessValidationQueues.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = (previous ?? Promise.resolve()).catch(() => undefined).then(() => current);
  inProcessValidationQueues.set(key, chain);

  if (previous) {
    const waitStartedAt = Date.now();
    logger.info(metadata, 'Queued GFS remediation validation behind an active in-process run');
    await previous.catch(() => undefined);
    logger.info(
      {
        ...metadata,
        queueWaitMs: Date.now() - waitStartedAt,
      },
      'Starting queued GFS remediation validation after prior run finished',
    );
  }

  try {
    return await fn();
  } finally {
    release();
    if (inProcessValidationQueues.get(key) === chain) {
      inProcessValidationQueues.delete(key);
    }
  }
}

function parsePostgresClientMajorVersion(output: string): string {
  const match = output.match(/\)\s+(\d+)(?:\.\d+)?/);
  if (match?.[1]) {
    return match[1];
  }

  const fallbackMatch = output.match(/\b(\d+)(?:\.\d+)?\b/);
  if (fallbackMatch?.[1]) {
    return fallbackMatch[1];
  }

  throw new Error(
    `Could not parse PostgreSQL client version from: '${output}'.`,
  );
}

function buildVersionedBinaryCandidates(
  program: 'psql' | 'pg_dump',
  majorVersion: string,
): string[] {
  return uniqueStrings([
    `${program}-${majorVersion}`,
    `${program}${majorVersion}`,
    `/usr/lib/postgresql/${majorVersion}/bin/${program}`,
    `/usr/pgsql-${majorVersion}/bin/${program}`,
    `/opt/homebrew/opt/libpq@${majorVersion}/bin/${program}`,
    `/usr/local/opt/libpq@${majorVersion}/bin/${program}`,
  ]);
}

function buildBootstrapBinaryCandidates(program: 'psql' | 'pg_dump'): string[] {
  return uniqueStrings([
    program,
    `/usr/bin/${program}`,
    `/usr/local/bin/${program}`,
    ...COMMON_POSTGRES_MAJOR_VERSIONS.flatMap((majorVersion) =>
      buildVersionedBinaryCandidates(program, majorVersion),
    ),
  ]);
}

async function runCommand(
  program: string,
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      program,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        signal: options.signal,
        timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr });
          return;
        }

        const typedError = error as ExecFileException;
        if (typedError.code === 'ENOENT') {
          reject(
            new Error(
              `Required CLI '${program}' was not found in PATH. Install it on the server before running GFS remediation validation.`,
            ),
          );
          return;
        }

        const stderrText = stderr.trim();
        const stdoutText = stdout.trim();
        const details = stderrText || stdoutText || typedError.message;
        reject(new Error(`${program} command failed: ${details}`));
      },
    );
  });
}

async function removeDirectoryTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true });
    return;
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }
  }

  try {
    await runCommand('podman', ['unshare', 'rm', '-rf', path], {});
  } catch (error) {
    if (isRemotePodmanUnshareUnsupportedError(error)) {
      return;
    }
    throw error;
  }
}

function isRemotePodmanUnshareUnsupportedError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    message.includes('remote podman client') &&
    /cannot use command ["']podman unshare["']/.test(message)
  );
}

async function tryReadCommandMajorVersion(
  program: string,
  signal: AbortSignal,
): Promise<string | null> {
  try {
    const result = await runCommand(program, ['--version'], {
      signal,
      timeoutMs: VERSION_CHECK_TIMEOUT_MS,
    });
    return parsePostgresClientMajorVersion(
      `${result.stdout}\n${result.stderr}`.trim(),
    );
  } catch {
    return null;
  }
}

async function resolveBootstrapBinary(
  program: 'psql' | 'pg_dump',
  signal: AbortSignal,
): Promise<string> {
  const envVar =
    program === 'psql'
      ? POSTGRES_CLIENT_ENV_VARS.psql
      : POSTGRES_CLIENT_ENV_VARS.pgDump;
  const configuredBinary = process.env[envVar]?.trim();
  if (configuredBinary) {
    const version = await tryReadCommandMajorVersion(configuredBinary, signal);
    if (!version) {
      throw new Error(
        `Configured PostgreSQL client '${configuredBinary}' from ${envVar} was not executable.`,
      );
    }
    return configuredBinary;
  }

  for (const candidate of buildBootstrapBinaryCandidates(program)) {
    const version = await tryReadCommandMajorVersion(candidate, signal);
    if (version) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find an executable ${program} binary. Install PostgreSQL client tools or set ${envVar}.`,
  );
}

async function resolveVersionMatchedBinary(
  program: 'psql' | 'pg_dump',
  majorVersion: string,
  signal: AbortSignal,
): Promise<string> {
  const envVar =
    program === 'psql'
      ? POSTGRES_CLIENT_ENV_VARS.psql
      : POSTGRES_CLIENT_ENV_VARS.pgDump;
  const configuredBinary = process.env[envVar]?.trim();

  if (configuredBinary) {
    const version = await tryReadCommandMajorVersion(configuredBinary, signal);
    if (!version) {
      throw new Error(
        `Configured PostgreSQL client '${configuredBinary}' from ${envVar} was not executable.`,
      );
    }
    if (version !== majorVersion) {
      throw new Error(
        `Configured PostgreSQL client '${configuredBinary}' from ${envVar} is version ${version}, but GFS validation requires PostgreSQL client major version ${majorVersion}.`,
      );
    }
    return configuredBinary;
  }

  for (const candidate of buildVersionedBinaryCandidates(
    program,
    majorVersion,
  )) {
    const version = await tryReadCommandMajorVersion(candidate, signal);
    if (version === majorVersion) {
      return candidate;
    }
  }

  const defaultVersion = await tryReadCommandMajorVersion(program, signal);
  if (defaultVersion === majorVersion) {
    return program;
  }

  const mismatchHint = defaultVersion
    ? `The default '${program}' on PATH is PostgreSQL ${defaultVersion}.`
    : `No default '${program}' binary was found on PATH.`;

  throw new Error(
    `Could not find a PostgreSQL ${majorVersion}-compatible ${program} binary. ${mismatchHint} Install matching PostgreSQL client tools or set ${envVar}.`,
  );
}

function buildPostgresCliEnv(connectionUrl: string): NodeJS.ProcessEnv {
  const url = new URL(connectionUrl);
  const env: NodeJS.ProcessEnv = { ...process.env };

  if (url.hostname) {
    env.PGHOST = url.hostname;
  }
  if (url.port) {
    env.PGPORT = url.port;
  }

  const database = url.pathname.replace(/^\//, '');
  if (database) {
    env.PGDATABASE = decodeURIComponent(database);
  }
  if (url.username) {
    env.PGUSER = decodeURIComponent(url.username);
  }
  if (url.password) {
    env.PGPASSWORD = decodeURIComponent(url.password);
  }

  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) {
    env.PGSSLMODE = sslmode;
  }

  return env;
}

async function runPsql(
  program: string,
  connectionUrl: string,
  sql: string,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const env = buildPostgresCliEnv(connectionUrl);
  const result = await runCommand(
    program,
    [
      '--no-psqlrc',
      '--set',
      'ON_ERROR_STOP=1',
      '--tuples-only',
      '--no-align',
      '-c',
      sql,
    ],
    { env, signal, timeoutMs },
  );

  return result.stdout.trim();
}

async function waitForPostgresReady(
  program: string,
  connectionUrl: string,
  signal: AbortSignal,
  logger?: Awaited<ReturnType<typeof getLogger>>,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  let attempts = 0;

  logger?.info(
    {
      host: new URL(connectionUrl).hostname,
      port: new URL(connectionUrl).port || '5432',
      timeoutMs: POSTGRES_READY_TIMEOUT_MS,
    },
    'Starting GFS PostgreSQL readiness polling',
  );

  while (Date.now() - startedAt < POSTGRES_READY_TIMEOUT_MS) {
    attempts += 1;
    try {
      await runPsql(
        program,
        connectionUrl,
        'SELECT 1',
        signal,
        POSTGRES_READY_CHECK_TIMEOUT_MS,
      );
      logger?.info(
        {
          attempts,
          elapsedMs: Date.now() - startedAt,
        },
        'GFS PostgreSQL readiness polling succeeded',
      );
      return;
    } catch (error) {
      if (!isRetryablePostgresStartupError(error)) {
        logger?.warn(
          {
            attempts,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          'GFS PostgreSQL readiness polling failed with non-retryable error',
        );
        throw error;
      }

      lastError =
        error instanceof Error ? error : new Error(String(error ?? 'unknown'));
      logger?.warn(
        {
          attempts,
          elapsedMs: Date.now() - startedAt,
          error: lastError.message,
        },
        'GFS PostgreSQL readiness polling attempt failed; retrying',
      );
      await waitForAbortableDelay(POSTGRES_READY_RETRY_DELAY_MS, signal);
    }
  }

  logger?.warn(
    {
      attempts,
      elapsedMs: Date.now() - startedAt,
      error: lastError?.message ?? 'unknown error',
      timeoutMs: POSTGRES_READY_TIMEOUT_MS,
    },
    'GFS PostgreSQL readiness polling timed out',
  );

  throw new Error(
    `Timed out waiting for the GFS PostgreSQL instance to accept connections after ${POSTGRES_READY_TIMEOUT_MS}ms. Last error: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function runGfsImportWithRetry(
  repoPath: string,
  dumpPath: string,
  signal: AbortSignal,
  logger?: Awaited<ReturnType<typeof getLogger>>,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;
  let attempts = 0;

  logger?.info(
    {
      repoPath,
      dumpPath,
      timeoutMs: POSTGRES_READY_TIMEOUT_MS,
    },
    'Starting GFS baseline import',
  );

  while (Date.now() - startedAt < POSTGRES_READY_TIMEOUT_MS) {
    attempts += 1;
    try {
      await runCommand(
        'gfs',
        ['import', '--file', dumpPath, '--format', 'sql'],
        { cwd: repoPath, signal },
      );
      logger?.info(
        {
          repoPath,
          dumpPath,
          attempts,
          elapsedMs: Date.now() - startedAt,
        },
        'GFS baseline import succeeded',
      );
      return;
    } catch (error) {
      if (!isRetryablePostgresStartupError(error)) {
        logger?.warn(
          {
            repoPath,
            dumpPath,
            attempts,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          },
          'GFS baseline import failed with non-retryable error',
        );
        throw error;
      }

      lastError =
        error instanceof Error ? error : new Error(String(error ?? 'unknown'));
      logger?.warn(
        {
          repoPath,
          dumpPath,
          attempts,
          elapsedMs: Date.now() - startedAt,
          error: lastError.message,
        },
        'GFS baseline import attempt failed; retrying',
      );
      await waitForAbortableDelay(POSTGRES_READY_RETRY_DELAY_MS, signal);
    }
  }

  logger?.warn(
    {
      repoPath,
      dumpPath,
      attempts,
      elapsedMs: Date.now() - startedAt,
      error: lastError?.message ?? 'unknown error',
      timeoutMs: POSTGRES_READY_TIMEOUT_MS,
    },
    'GFS baseline import timed out',
  );

  throw new Error(
    `Timed out importing the baseline dump into the GFS PostgreSQL instance after ${POSTGRES_READY_TIMEOUT_MS}ms. Last error: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function runPsqlWithRetry(
  program: string,
  connectionUrl: string,
  sql: string,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<string> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < POSTGRES_READY_TIMEOUT_MS) {
    try {
      return await runPsql(program, connectionUrl, sql, signal, timeoutMs);
    } catch (error) {
      if (!isRetryablePostgresStartupError(error)) {
        throw error;
      }

      lastError =
        error instanceof Error ? error : new Error(String(error ?? 'unknown'));
      await waitForPostgresReady(program, connectionUrl, signal);
      await waitForAbortableDelay(POSTGRES_READY_RETRY_DELAY_MS, signal);
    }
  }

  throw new Error(
    `Timed out executing SQL against the GFS PostgreSQL instance after ${POSTGRES_READY_TIMEOUT_MS}ms. Last error: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function readPostgresMajorVersion(
  psqlBinary: string,
  connectionUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const output = await runPsql(
    psqlBinary,
    connectionUrl,
    "SELECT current_setting('server_version_num')",
    signal,
  );
  const versionNum = Number.parseInt(output, 10);

  if (!Number.isFinite(versionNum) || versionNum <= 0) {
    throw new Error(
      `Could not parse PostgreSQL server_version_num: '${output}'.`,
    );
  }

  return String(Math.trunc(versionNum / 10000));
}

async function resolvePostgresClientBinaries(
  connectionUrl: string,
  signal: AbortSignal,
): Promise<ResolvedPostgresClientBinaries> {
  const bootstrapPsql = await resolveBootstrapBinary('psql', signal);
  const majorVersion = await readPostgresMajorVersion(
    bootstrapPsql,
    connectionUrl,
    signal,
  );

  return {
    majorVersion,
    psql: await resolveVersionMatchedBinary('psql', majorVersion, signal),
    pgDump: await resolveVersionMatchedBinary('pg_dump', majorVersion, signal),
  };
}

async function readBaselineMetadata(
  metadataPath: string,
): Promise<GfsBaselineMetadata | null> {
  try {
    return JSON.parse(
      await readFile(metadataPath, 'utf8'),
    ) as GfsBaselineMetadata;
  } catch {
    return null;
  }
}

async function writeBaselineMetadata(
  metadataPath: string,
  metadata: GfsBaselineMetadata,
): Promise<void> {
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), 'utf8');
}

async function touchBaselineMetadata(
  metadataPath: string,
  mutate: (metadata: GfsBaselineMetadata | null) => GfsBaselineMetadata,
): Promise<void> {
  const next = mutate(await readBaselineMetadata(metadataPath));
  await writeBaselineMetadata(metadataPath, {
    ...next,
    updatedAt: new Date().toISOString(),
  });
}

async function isRecoverableBaselineRepo(repoPath: string): Promise<boolean> {
  return pathExists(join(repoPath, '.gfs', 'HEAD'));
}

function shouldDeleteExpiredBaselineCache(input: {
  metadata: GfsBaselineMetadata | null;
  cacheMtimeMs: number;
  nowMs: number;
}): boolean {
  const metadataCreatedAtMs = input.metadata?.createdAt
    ? Date.parse(input.metadata.createdAt)
    : Number.NaN;
  const lastTouchedMs = Number.isFinite(metadataCreatedAtMs)
    ? metadataCreatedAtMs
    : input.cacheMtimeMs;

  return input.nowMs - lastTouchedMs > GFS_BASELINE_CACHE_MAX_AGE_MS;
}

async function cleanupExpiredBaselineCaches(input: {
  baselineRoot: string;
  activeCacheKey: string;
  logger?: Awaited<ReturnType<typeof getLogger>>;
  nowMs?: number;
}): Promise<void> {
  const nowMs = input.nowMs ?? Date.now();

  try {
    const entries = await readdir(input.baselineRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (
        entry.name.endsWith('.lock') ||
        entry.name === input.activeCacheKey ||
        entry.name.includes(GFS_BASELINE_BUILD_SUFFIX)
      ) {
        continue;
      }

      const cacheDir = join(input.baselineRoot, entry.name);
      const lockDir = join(input.baselineRoot, `${entry.name}.lock`);
      if (await pathExists(lockDir)) {
        continue;
      }

      const cacheStat = await stat(cacheDir).catch(() => null);
      if (!cacheStat) {
        continue;
      }

      const metadata = await readBaselineMetadata(
        join(cacheDir, GFS_BASELINE_METADATA_FILENAME),
      );

      if (
        !shouldDeleteExpiredBaselineCache({
          metadata,
          cacheMtimeMs: cacheStat.mtimeMs,
          nowMs,
        })
      ) {
        continue;
      }

      await removeDirectoryTree(cacheDir);
      input.logger?.info(
        {
          cacheDir,
          ageDays: Number(
            (((nowMs - cacheStat.mtimeMs) / (24 * 60 * 60 * 1000)).toFixed(2)),
          ),
          maxAgeDays: GFS_BASELINE_CACHE_MAX_AGE_MS / (24 * 60 * 60 * 1000),
        },
        'Removed expired cached GFS baseline repo',
      );
    }
  } catch (error) {
    input.logger?.warn(
      {
        baselineRoot: input.baselineRoot,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to clean up expired cached GFS baseline repos',
    );
  }
}

async function tryRecoverBaselineRepo(input: {
  cacheDir: string;
  repoPath: string;
  metadataPath: string;
  connectionUrl: string;
  signal: AbortSignal;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<EnsuredGfsBaseline | null> {
  if (!(await isRecoverableBaselineRepo(input.repoPath))) {
    return null;
  }

  try {
    const postgresClients = await resolvePostgresClientBinaries(
      input.connectionUrl,
      input.signal,
    );
    const checkpointCommit = await readLatestCommitHash(
      input.repoPath,
      input.signal,
    );
    const metadata = createBaselineMetadata({
      state: 'ready',
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
    });
    await writeBaselineMetadata(
      input.metadataPath,
      metadata,
    );

    input.logger.info(
      {
        cacheDir: input.cacheDir,
        repoPath: input.repoPath,
        checkpointCommit,
      },
      'Recovered cached GFS baseline metadata from existing repo',
    );

    return {
      cacheDir: input.cacheDir,
      repoPath: input.repoPath,
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
      psqlBinary: postgresClients.psql,
      pgDumpBinary: postgresClients.pgDump,
      reused: true,
      computeRunning: false,
    };
  } catch (error) {
    input.logger.warn(
      {
        cacheDir: input.cacheDir,
        repoPath: input.repoPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to recover cached GFS baseline repo metadata',
    );
    return null;
  }
}

async function prepareFreshCacheLocation(input: {
  cacheDir: string;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<{ cacheDir: string; repoPath: string; metadataPath: string }> {
  const stagingCacheDir = buildBaselineStagingCacheDir(input.cacheDir);
  try {
    await removeDirectoryTree(input.cacheDir).catch(() => undefined);
    await removeDirectoryTree(stagingCacheDir).catch(() => undefined);
    await mkdir(stagingCacheDir, { recursive: true });
    return {
      cacheDir: stagingCacheDir,
      repoPath: join(stagingCacheDir, 'repo'),
      metadataPath: join(stagingCacheDir, GFS_BASELINE_METADATA_FILENAME),
    };
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }

    const fallbackCacheDir = `${stagingCacheDir}-rebuild`;
    input.logger.warn(
      {
        cacheDir: input.cacheDir,
        fallbackCacheDir,
        error: error instanceof Error ? error.message : String(error),
      },
      'Could not remove stale cached GFS baseline repo; using a fresh fallback cache directory',
    );
    await mkdir(fallbackCacheDir, { recursive: true });
    return {
      cacheDir: fallbackCacheDir,
      repoPath: join(fallbackCacheDir, 'repo'),
      metadataPath: join(fallbackCacheDir, GFS_BASELINE_METADATA_FILENAME),
    };
  }
}

async function publishReadyBaselineCache(input: {
  finalCacheDir: string;
  stagingCacheDir: string;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<string> {
  await removeDirectoryTree(input.finalCacheDir).catch(() => undefined);
  try {
    await rename(input.stagingCacheDir, input.finalCacheDir);
    return input.finalCacheDir;
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }

    input.logger.warn(
      {
        finalCacheDir: input.finalCacheDir,
        stagingCacheDir: input.stagingCacheDir,
        error: error instanceof Error ? error.message : String(error),
      },
      'Could not atomically publish cached GFS baseline repo; keeping staging cache directory',
    );
    return input.stagingCacheDir;
  }
}

async function createIsolatedValidationRepo(input: {
  workingRoot: string;
  cacheKey: string;
  sourceRepoPath: string;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<IsolatedValidationRepo> {
  const workingDir = join(
    input.workingRoot,
    GFS_VALIDATION_RUNS_SUBDIR,
    `${input.cacheKey}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  );
  const repoPath = join(workingDir, 'repo');

  await mkdir(workingDir, { recursive: true });

  try {
    await cp(input.sourceRepoPath, repoPath, { recursive: true, force: true });
    return {
      workingDir,
      repoPath,
    };
  } catch (error) {
    await removeDirectoryTree(workingDir).catch(() => undefined);
    input.logger.warn(
      {
        workingDir,
        sourceRepoPath: input.sourceRepoPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to create isolated GFS validation repo',
    );
    throw error;
  }
}

async function ensureGfsBaselineRepo(input: {
  cacheDir: string;
  repoPath: string;
  metadataPath: string;
  connectionUrl: string;
  signal: AbortSignal;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<EnsuredGfsBaseline> {
  const existingMetadata = await readBaselineMetadata(input.metadataPath);
  if (
    isReadyBaselineMetadata(existingMetadata) &&
    (await isRecoverableBaselineRepo(input.repoPath))
  ) {
    return {
      cacheDir: input.cacheDir,
      repoPath: input.repoPath,
      checkpointCommit: existingMetadata.checkpointCommit,
      postgresMajorVersion: existingMetadata.postgresMajorVersion,
      psqlBinary: await resolveVersionMatchedBinary(
        'psql',
        existingMetadata.postgresMajorVersion,
        input.signal,
      ),
      pgDumpBinary: null,
      reused: true,
      computeRunning: false,
    };
  }

  const recovered = await tryRecoverBaselineRepo(input);
  if (recovered) {
    return recovered;
  }

  const freshLocation = await prepareFreshCacheLocation({
    cacheDir: input.cacheDir,
    logger: input.logger,
  });
  await mkdir(freshLocation.repoPath, { recursive: true });
  await writeBaselineMetadata(
    freshLocation.metadataPath,
    createBaselineMetadata({ state: 'building' }),
  );

  const postgresClients = await resolvePostgresClientBinaries(
    input.connectionUrl,
    input.signal,
  );
  const dumpPath = join(
    freshLocation.cacheDir,
    `baseline-${randomUUID().slice(0, 8)}.sql`,
  );
  let shouldStopCompute = false;

  await touchBaselineMetadata(freshLocation.metadataPath, (metadata) =>
    createBaselineMetadata({
      state: 'building',
      createdAt: metadata?.createdAt,
    }),
  );

  logValidationStage({
    logger: input.logger,
    stage: 'baseline.pg_dump.start',
    message: 'Starting PostgreSQL baseline dump for GFS validation',
    metadata: {
      cacheDir: freshLocation.cacheDir,
      repoPath: freshLocation.repoPath,
      dumpPath,
      timeoutMs: PG_DUMP_TIMEOUT_MS,
    },
  });
  const pgDumpStartedAt = Date.now();
  const pgDumpProgressInterval = setInterval(() => {
    void stat(dumpPath)
      .then((dumpStat) => {
        logValidationStage({
          logger: input.logger,
          stage: 'baseline.pg_dump.progress',
          message: 'PostgreSQL baseline dump still running',
          metadata: {
            dumpPath,
            elapsedMs: Date.now() - pgDumpStartedAt,
            dumpBytes: dumpStat.size,
          },
        });
      })
      .catch(() => undefined);
  }, 30_000);

  try {
    await runCommand(
      postgresClients.pgDump,
      ['--format=plain', '--no-owner', '--no-privileges', '--file', dumpPath],
      {
        env: buildPostgresCliEnv(input.connectionUrl),
        signal: input.signal,
        timeoutMs: PG_DUMP_TIMEOUT_MS,
      },
    );
  } finally {
    clearInterval(pgDumpProgressInterval);
  }

  const dumpStat = await stat(dumpPath).catch(() => null);
  logValidationStage({
    logger: input.logger,
    stage: 'baseline.pg_dump.complete',
    message: 'Completed PostgreSQL baseline dump for GFS validation',
    metadata: {
      dumpPath,
      elapsedMs: Date.now() - pgDumpStartedAt,
      dumpBytes: dumpStat?.size ?? null,
    },
  });

  await touchBaselineMetadata(freshLocation.metadataPath, (metadata) =>
    createBaselineMetadata({
      state: 'building',
      postgresMajorVersion: postgresClients.majorVersion,
      createdAt: metadata?.createdAt,
    }),
  );

  try {
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.gfs_init.start',
      message: 'Initializing cached GFS baseline repository',
      metadata: {
        repoPath: freshLocation.repoPath,
        postgresMajorVersion: postgresClients.majorVersion,
      },
    });
    await runCommand(
      'gfs',
      [
        'init',
        '--database-provider',
        'postgres',
        '--database-version',
        postgresClients.majorVersion,
      ],
      { cwd: freshLocation.repoPath, signal: input.signal },
    );
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.gfs_config.start',
      message: 'Configuring cached GFS baseline repository for audit compatibility',
      metadata: {
        repoPath: freshLocation.repoPath,
        storageReflink: false,
      },
    });
    await runCommand(
      'gfs',
      ['config', 'storage.reflink', 'false'],
      { cwd: freshLocation.repoPath, signal: input.signal },
    );
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.gfs_config.complete',
      message: 'Configured cached GFS baseline repository for audit compatibility',
      metadata: {
        repoPath: freshLocation.repoPath,
        storageReflink: false,
      },
    });
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.gfs_init.complete',
      message: 'Initialized cached GFS baseline repository',
      metadata: {
        repoPath: freshLocation.repoPath,
      },
    });

    logValidationStage({
      logger: input.logger,
      stage: 'baseline.compute.start',
      message: 'Starting GFS compute for cached baseline repo',
      metadata: {
        repoPath: freshLocation.repoPath,
      },
    });
    try {
      await runCommand('gfs', ['compute', 'start'], {
        cwd: freshLocation.repoPath,
        signal: input.signal,
      });
      shouldStopCompute = true;
    } catch (error) {
      input.logger.warn(
        {
          repoPath: freshLocation.repoPath,
          error: error instanceof Error ? error.message : String(error),
        },
        'GFS compute start failed for cached baseline repo',
      );
      throw error;
    }
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.compute.ready',
      message: 'GFS compute started for cached baseline repo',
      metadata: {
        repoPath: freshLocation.repoPath,
      },
    });

    const importStatus = await readGfsConnectionUrl(
      freshLocation.repoPath,
      input.signal,
    );
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.compute.connection',
      message: 'Read GFS PostgreSQL connection details for cached baseline repo',
      metadata: {
        repoPath: freshLocation.repoPath,
        host: new URL(importStatus.connectionUrl).hostname,
        port: new URL(importStatus.connectionUrl).port || '5432',
      },
    });
    await waitForPostgresReady(
      postgresClients.psql,
      importStatus.connectionUrl,
      input.signal,
      input.logger,
    );
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.import.start',
      message: 'Beginning baseline dump import into GFS cached repo',
      metadata: {
        repoPath: freshLocation.repoPath,
        dumpPath,
      },
    });
    await runGfsImportWithRetry(
      freshLocation.repoPath,
      dumpPath,
      input.signal,
      input.logger,
    );
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.import.complete',
      message: 'Finished baseline dump import into GFS cached repo',
      metadata: {
        repoPath: freshLocation.repoPath,
      },
    });
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.commit.start',
      message: 'Creating cached baseline checkpoint commit',
      metadata: {
        repoPath: freshLocation.repoPath,
      },
    });
    await runCommand(
      'gfs',
      ['commit', '-m', 'baseline snapshot before audit remediation'],
      { cwd: freshLocation.repoPath, signal: input.signal },
    );

    const checkpointCommit = await readLatestCommitHash(
      freshLocation.repoPath,
      input.signal,
    );
    if (shouldStopCompute) {
      logValidationStage({
        logger: input.logger,
        stage: 'baseline.compute.stop.start',
        message: 'Stopping GFS compute before publishing cached baseline repo',
        metadata: {
          repoPath: freshLocation.repoPath,
        },
      });
      await runCommand('gfs', ['compute', 'stop'], {
        cwd: freshLocation.repoPath,
        signal: input.signal,
        timeoutMs: COMPUTE_STOP_TIMEOUT_MS,
      });
      shouldStopCompute = false;
      logValidationStage({
        logger: input.logger,
        stage: 'baseline.compute.stop.complete',
        message: 'Stopped GFS compute before publishing cached baseline repo',
        metadata: {
          repoPath: freshLocation.repoPath,
        },
      });
    }
    const metadata = createBaselineMetadata({
      state: 'ready',
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
    });
    await writeBaselineMetadata(
      freshLocation.metadataPath,
      metadata,
    );
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.commit.complete',
      message: 'Created cached baseline checkpoint commit',
      metadata: {
        repoPath: freshLocation.repoPath,
        checkpointCommit,
      },
    });
    const publishedCacheDir = await publishReadyBaselineCache({
      finalCacheDir: input.cacheDir,
      stagingCacheDir: freshLocation.cacheDir,
      logger: input.logger,
    });
    logValidationStage({
      logger: input.logger,
      stage: 'baseline.publish.complete',
      message: 'Published ready cached GFS baseline repo',
      metadata: {
        cacheDir: publishedCacheDir,
        checkpointCommit,
      },
    });

    return {
      cacheDir: publishedCacheDir,
      repoPath: join(publishedCacheDir, 'repo'),
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
      psqlBinary: postgresClients.psql,
      pgDumpBinary: postgresClients.pgDump,
      reused: false,
      computeRunning: false,
    };
  } catch (error) {
    await writeBaselineMetadata(
      freshLocation.metadataPath,
      createBaselineMetadata({
        state: 'failed',
        postgresMajorVersion: postgresClients.majorVersion,
        error: error instanceof Error ? error.message : String(error),
      }),
    ).catch(() => undefined);
    if (shouldStopCompute) {
      await runCommand('gfs', ['compute', 'stop'], {
        cwd: freshLocation.repoPath,
        timeoutMs: COMPUTE_STOP_TIMEOUT_MS,
      }).catch((stopError) => {
        input.logger.warn(
          {
            repoPath: freshLocation.repoPath,
            error:
              stopError instanceof Error
                ? stopError.message
                : String(stopError),
          },
          'Failed to stop GFS compute after baseline creation failure',
        );
      });
    }
    input.logger.warn(
      {
        repoPath: freshLocation.repoPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to create cached GFS baseline repo; removing partial cache',
    );
    await removeDirectoryTree(freshLocation.cacheDir).catch(() => {
      // Best-effort cleanup of partial cache state.
    });
    throw error;
  } finally {
    await unlink(dumpPath).catch(() => {
      // Best-effort dump cleanup.
    });
  }
}

async function checkoutAuditBranch(input: {
  repoPath: string;
  requestedBranchName: string;
  startRevision: string;
  signal: AbortSignal;
}): Promise<{ branchName: string; adjusted: boolean }> {
  try {
    await runCommand(
      'gfs',
      ['checkout', '-b', input.requestedBranchName, input.startRevision],
      {
        cwd: input.repoPath,
        signal: input.signal,
      },
    );
    return {
      branchName: input.requestedBranchName,
      adjusted: false,
    };
  } catch (error) {
    if (!isExistingBranchError(error)) {
      throw error;
    }

    const fallbackBranchName = buildBranchNameWithSuffix(
      input.requestedBranchName,
      randomUUID().slice(0, 8),
    );

    await runCommand(
      'gfs',
      ['checkout', '-b', fallbackBranchName, input.startRevision],
      {
        cwd: input.repoPath,
        signal: input.signal,
      },
    );

    return {
      branchName: fallbackBranchName,
      adjusted: true,
    };
  }
}

export const __testables = {
  assessValidationResult,
  buildBaselineCacheKey,
  buildBranchNameWithSuffix,
  buildBootstrapBinaryCandidates,
  buildSessionScopedExplainSql,
  buildVersionedBinaryCandidates,
  cleanupExpiredBaselineCaches,
  extractExplainJsonPayload,
  isExistingBranchError,
  isPermissionDeniedError,
  isRemotePodmanUnshareUnsupportedError,
  isRetryablePostgresStartupError,
  partitionActionStatements,
  parseExplainPlanSummary,
  parseCommitHash,
  parseExplainMetrics,
  parseLatestCommitHashFromGfsLogJson,
  parsePostgresClientMajorVersion,
  resolveGfsAuditWorkingRoot,
  shouldDeleteExpiredBaselineCache,
  withDirectoryLock,
};

async function readGfsStatus(
  repoPath: string,
  signal: AbortSignal,
): Promise<GfsStatusResponse> {
  const result = await runCommand('gfs', ['status', '--output', 'json'], {
    cwd: repoPath,
    signal,
  });
  return JSON.parse(result.stdout) as GfsStatusResponse;
}

async function readLatestCommitHash(
  repoPath: string,
  signal: AbortSignal,
): Promise<string> {
  const result = await runCommand('gfs', ['--json', 'log', '--max-count', '1'], {
    cwd: repoPath,
    signal,
  });
  return parseLatestCommitHashFromGfsLogJson(result.stdout);
}

async function readGfsConnectionUrl(
  repoPath: string,
  signal: AbortSignal,
): Promise<{ branch: string; connectionUrl: string }> {
  const parsed = await readGfsStatus(repoPath, signal);
  const connectionUrl = parsed.compute?.connection_string?.trim();

  if (!connectionUrl) {
    throw new Error('GFS status did not return a database connection string.');
  }

  return {
    branch: parsed.current_branch,
    connectionUrl,
  };
}

export const ValidateRemediationInGfsCliTool = Tool.define(
  'validate_remediation_in_gfs_cli',
  {
    description: DESCRIPTION,
    parameters: z.object({
      validationQuery: z
        .string()
        .describe(
          'SELECT or WITH query to benchmark before and after the remediation. Keep SET, RESET, ANALYZE, CREATE INDEX, and other changes in actionStatements.',
        ),
      actionStatements: z
        .array(z.string())
        .min(1)
        .max(MAX_ACTIONS)
        .describe(
          'SQL statements to run on the isolated GFS branch. Provide one statement per array item.',
        ),
      branchName: z
        .string()
        .min(3)
        .max(63)
        .optional()
        .describe(
          'Optional branch name. When omitted, a unique audit branch name is generated.',
        ),
      validationType: z
        .enum(['latency', 'config', 'maintenance'])
        .optional()
        .default('latency')
        .describe(
          'Type of validation: "latency" for query performance (default), "config" for setting changes (SET/ALTER SYSTEM), "maintenance" for ANALYZE/VACUUM/DROP INDEX.',
        ),
    }),
    async execute(params, ctx) {
      assertExplainTargetSql(
        params.validationQuery,
        'validate_remediation_in_gfs_cli',
      );
      const actionStatements = params.actionStatements.map(
        normalizeActionStatement,
      );
      const partitionedStatements = partitionActionStatements(actionStatements);

      const logger = await getLogger();
      const { datasource } = await resolveAttachedDatasource(ctx);

      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `validate_remediation_in_gfs_cli currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const connectionUrl = extractConnectionUrl(
        datasource.config as Record<string, unknown>,
        'postgres',
      );
      const branchName = sanitizeBranchName(
        params.branchName ?? `audit-${Date.now()}-${randomUUID().slice(0, 8)}`,
      );

      await ctx.metadata({
        title: 'Validate remediation with GFS CLI',
        metadata: {
          datasourceId: datasource.id,
          datasourceName: datasource.name,
          branchName,
        },
      });

      const workingRoot = resolveGfsAuditWorkingRoot();
      await mkdir(workingRoot, { recursive: true });
      const baselineRoot = join(workingRoot, GFS_BASELINE_CACHE_SUBDIR);
      await mkdir(baselineRoot, { recursive: true });
      const cacheKey = buildBaselineCacheKey({
        datasourceId: datasource.id,
        connectionUrl,
      });
      await cleanupExpiredBaselineCaches({
        baselineRoot,
        activeCacheKey: cacheKey,
        logger,
      });
      const cacheDir = join(baselineRoot, cacheKey);
      const repoPath = join(cacheDir, 'repo');
      const metadataPath = join(cacheDir, GFS_BASELINE_METADATA_FILENAME);
      const lockDir = join(baselineRoot, `${cacheKey}.lock`);

      logger.info(
        {
          conversationId: ctx.conversationId,
          datasourceId: datasource.id,
          datasourceProvider: datasource.datasource_provider,
          branchName,
          cacheKey,
          repoPath,
        },
        'Starting GFS CLI remediation validation',
      );

      const concurrentValidationMessage =
        'Another GFS remediation validation is already running for this datasource in this conversation. Run validate_remediation_in_gfs_cli one recommendation at a time.';

      return withInProcessValidationQueue(
        cacheKey,
        logger,
        {
          conversationId: ctx.conversationId,
          datasourceId: datasource.id,
          branchName,
          cacheKey,
          repoPath,
        },
        () =>
          withDirectoryLock(
            lockDir,
            ctx.abort,
            async () => {
          let shouldStopCompute = false;
          let activeRepoPath = repoPath;
          let activeWorkingDir: string | null = null;

          try {
            await runCommand('gfs', ['version'], { signal: ctx.abort });

            const baseline = await ensureGfsBaselineRepo({
              cacheDir,
              repoPath,
              metadataPath,
              connectionUrl,
              signal: ctx.abort,
              logger,
            });
            shouldStopCompute = baseline.computeRunning;
            activeRepoPath = baseline.repoPath;
            logValidationStage({
              logger,
              stage: 'validation.baseline.ready',
              message: baseline.reused
                ? 'Using existing cached GFS baseline repo'
                : 'Using newly created cached GFS baseline repo',
              metadata: {
                cacheDir: baseline.cacheDir,
                repoPath: activeRepoPath,
                checkpointCommit: baseline.checkpointCommit,
                reused: baseline.reused,
              },
            });

            const isolatedRepo = await createIsolatedValidationRepo({
              workingRoot,
              cacheKey,
              sourceRepoPath: baseline.repoPath,
              logger,
            });
            activeWorkingDir = isolatedRepo.workingDir;
            activeRepoPath = isolatedRepo.repoPath;
            logValidationStage({
              logger,
              stage: 'validation.repo.ready',
              message: 'Prepared isolated GFS repo for remediation validation',
              metadata: {
                workingDir: activeWorkingDir,
                repoPath: activeRepoPath,
                baselineRepoPath: baseline.repoPath,
              },
            });

            await ctx.metadata({
              title: baseline.reused
                ? 'Reused cached GFS baseline repo'
                : 'Created cached GFS baseline repo',
              metadata: {
                cacheKey,
                cacheDir: baseline.cacheDir,
                repoPath: activeRepoPath,
                baselineRepoPath: baseline.repoPath,
                checkpointCommit: baseline.checkpointCommit,
                postgresMajorVersion: baseline.postgresMajorVersion,
                psqlBinary: baseline.psqlBinary,
                pgDumpBinary: baseline.pgDumpBinary,
              },
            });

            const checkoutResult = await checkoutAuditBranch({
              repoPath: activeRepoPath,
              requestedBranchName: branchName,
              startRevision: baseline.checkpointCommit,
              signal: ctx.abort,
            });
            const effectiveBranchName = checkoutResult.branchName;
            logValidationStage({
              logger,
              stage: 'validation.branch.ready',
              message: 'Prepared isolated GFS audit branch for remediation validation',
              metadata: {
                repoPath: activeRepoPath,
                branchName: effectiveBranchName,
                adjusted: checkoutResult.adjusted,
              },
            });
            if (checkoutResult.adjusted) {
              await ctx.metadata({
                title: 'Adjusted GFS branch name',
                metadata: {
                  requestedBranchName: branchName,
                  branchName: effectiveBranchName,
                },
              });
            }

            if (!baseline.computeRunning) {
              logValidationStage({
                logger,
                stage: 'validation.compute.start',
                message: 'Starting GFS compute for remediation validation branch',
                metadata: {
                  repoPath: activeRepoPath,
                  branchName: effectiveBranchName,
                },
              });
              await runCommand('gfs', ['compute', 'start'], {
                cwd: activeRepoPath,
                signal: ctx.abort,
              });
              shouldStopCompute = true;
            }

            const statusBefore = await readGfsConnectionUrl(
              activeRepoPath,
              ctx.abort,
            );
            logValidationStage({
              logger,
              stage: 'validation.benchmark.before.start',
              message: 'Running before benchmark on GFS validation branch',
              metadata: {
                repoPath: activeRepoPath,
                branchName: effectiveBranchName,
                validationType: params.validationType,
              },
            });
            await waitForPostgresReady(
              baseline.psqlBinary,
              statusBefore.connectionUrl,
              ctx.abort,
            );
            const before = parseExplainAnalysis(
              await runPsqlWithRetry(
                baseline.psqlBinary,
                statusBefore.connectionUrl,
                buildExplainSql(params.validationQuery),
                ctx.abort,
              ),
            );

            const executedActions = [...actionStatements];
            for (const statement of partitionedStatements.persistentStatements) {
              logValidationStage({
                logger,
                stage: 'validation.action.apply',
                message: 'Applying persistent remediation statement in GFS validation branch',
                metadata: {
                  repoPath: activeRepoPath,
                  branchName: effectiveBranchName,
                  statement,
                },
              });
              await runPsqlWithRetry(
                baseline.psqlBinary,
                statusBefore.connectionUrl,
                statement,
                ctx.abort,
              );
            }

            if (partitionedStatements.persistentStatements.length > 0) {
              logValidationStage({
                logger,
                stage: 'validation.action.commit',
                message: 'Creating GFS commit for persistent remediation statements',
                metadata: {
                  repoPath: activeRepoPath,
                  branchName: effectiveBranchName,
                  statements: partitionedStatements.persistentStatements.length,
                },
              });
              await runCommand(
                'gfs',
                ['commit', '-m', 'apply audit remediation candidate'],
                {
                  cwd: activeRepoPath,
                  signal: ctx.abort,
                },
              );
            }

            const afterCommit = await readLatestCommitHash(
              activeRepoPath,
              ctx.abort,
            );
            const statusAfter = await readGfsConnectionUrl(
              activeRepoPath,
              ctx.abort,
            );
            await waitForPostgresReady(
              baseline.psqlBinary,
              statusAfter.connectionUrl,
              ctx.abort,
            );
            const afterExplainSql =
              partitionedStatements.sessionSetupStatements.length > 0 ||
              partitionedStatements.sessionTeardownStatements.length > 0
                ? buildSessionScopedExplainSql({
                    validationQuery: params.validationQuery,
                    sessionSetupStatements:
                      partitionedStatements.sessionSetupStatements,
                    sessionTeardownStatements:
                      partitionedStatements.sessionTeardownStatements,
                  })
                : buildExplainSql(params.validationQuery);
            logValidationStage({
              logger,
              stage: 'validation.benchmark.after.start',
              message: 'Running after benchmark on GFS validation branch',
              metadata: {
                repoPath: activeRepoPath,
                branchName: statusAfter.branch,
              },
            });
            const after = parseExplainAnalysis(
              await runPsqlWithRetry(
                baseline.psqlBinary,
                statusAfter.connectionUrl,
                afterExplainSql,
                ctx.abort,
              ),
            );

            const totalDeltaMs = Number(
              (after.totalTimeMs - before.totalTimeMs).toFixed(3),
            );
            const executionDeltaMs = Number(
              (after.executionTimeMs - before.executionTimeMs).toFixed(3),
            );
            const deltaPct =
              before.totalTimeMs > 0
                ? Number(((totalDeltaMs / before.totalTimeMs) * 100).toFixed(2))
                : null;
            const assessment = assessValidationResult(
              before,
              after,
              params.validationType,
              actionStatements,
            );
            logValidationStage({
              logger,
              stage: 'validation.complete',
              message: 'Completed GFS remediation validation benchmark',
              metadata: {
                repoPath: activeRepoPath,
                branchName: statusAfter.branch,
                beforeMs: before.totalTimeMs,
                afterMs: after.totalTimeMs,
                deltaMs: totalDeltaMs,
                deltaPct,
                recommendationStatus: assessment.recommendationStatus,
              },
            });

            return {
              originalDatabaseUnchanged: true,
              datasource: {
                id: datasource.id,
                name: datasource.name,
                provider: datasource.datasource_provider,
              },
              gfs: {
                repoPath: activeRepoPath,
                branchName: statusAfter.branch,
                checkpointCommit: baseline.checkpointCommit,
                afterCommit,
                rollback: {
                  restoreCheckpoint: `gfs checkout ${baseline.checkpointCommit}`,
                  returnToBranch: `gfs checkout ${statusAfter.branch}`,
                },
              },
              validation: {
                query: params.validationQuery.trim(),
                actionsApplied: executedActions,
                before,
                after,
                delta: {
                  totalTimeMs: totalDeltaMs,
                  executionTimeMs: executionDeltaMs,
                  totalTimePct: deltaPct,
                },
                assessment,
              },
            };
          } finally {
            if (shouldStopCompute) {
              await runCommand('gfs', ['compute', 'stop'], {
                cwd: activeRepoPath,
                timeoutMs: COMPUTE_STOP_TIMEOUT_MS,
              }).catch((error) => {
                logger.warn(
                  {
                    repoPath: activeRepoPath,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  'Failed to stop GFS compute after remediation validation',
                );
              });
            }
            if (activeWorkingDir) {
              await removeDirectoryTree(activeWorkingDir).catch((error) => {
                logger.warn(
                  {
                    workingDir: activeWorkingDir,
                    error:
                      error instanceof Error ? error.message : String(error),
                  },
                  'Failed to remove isolated GFS validation repo after remediation validation',
                );
              });
            }
          }
            },
            {
              waitOnBusy: false,
              busyMessage: concurrentValidationMessage,
            },
          ),
      );
    },
  },
);
