import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
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

const DESCRIPTION = `Create a temporary GFS repository from a prepared PostgreSQL dump, create an isolated audit branch, run before/after EXPLAIN ANALYZE measurements around remediation SQL, and return the branch, commits, metrics, and rollback commands. Use this when a recommendation should be validated safely away from the original datasource.`;

const MAX_ACTIONS = 10;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const VERSION_CHECK_TIMEOUT_MS = 30 * 1000;
const COMPUTE_STOP_TIMEOUT_MS = 30 * 1000;
const POSTGRES_READY_TIMEOUT_MS = 60 * 1000;
const POSTGRES_READY_RETRY_DELAY_MS = 1000;
const POSTGRES_READY_CHECK_TIMEOUT_MS = 5000;
const GFS_AUDIT_ROOT_ENV_VAR = 'QWERY_GFS_AUDITS_DIR';
const GFS_DUMPS_DIR_ENV_VAR = 'QWERY_GFS_DUMPS_DIR';
const GFS_DUMP_FILE_ENV_VAR = 'QWERY_GFS_DUMP_FILE';
const GFS_AUDIT_ROOT_SUBDIR = 'qwery/gfs-audits';
const GFS_DUMPS_SUBDIR = 'qwery/gfs-dumps';
const GFS_VALIDATION_RUNS_SUBDIR = 'runs';
const MIN_LATENCY_IMPACT_BENCHMARK_MS = 5;
const NEUTRAL_DELTA_ABS_MS = 1;
const NEUTRAL_DELTA_PCT = 10;
const PSQL_BIN_ENV_VAR = 'QWERY_PSQL_BIN';
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
  benchmarkSuitability: 'latency-impact' | 'low-latency';
  rationale: string;
  cautions: string[];
};

type ValidationType = 'latency' | 'config' | 'maintenance';

type GfsStatusResponse = {
  current_branch: string;
  compute?: {
    connection_string: string;
  } | null;
};

type ResolvedPostgresClientBinaries = {
  psql: string;
  majorVersion: string;
};

type EnsuredGfsBaseline = {
  checkpointCommit: string;
  postgresMajorVersion: string;
  psqlBinary: string;
};

type PartitionedActionStatements = {
  persistentStatements: string[];
  sessionSetupStatements: string[];
  sessionTeardownStatements: string[];
};

let gfsValidationQueue: Promise<void> = Promise.resolve();

async function runGfsValidationExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const previous = gfsValidationQueue.catch(() => {
    // Keep the queue moving even if a previous validation failed.
  });
  let releaseQueue!: () => void;
  gfsValidationQueue = new Promise<void>((resolve) => {
    releaseQueue = resolve;
  });

  await previous;
  try {
    return await fn();
  } finally {
    releaseQueue();
  }
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

function assessValidationResult(
  before: ExplainAnalysis,
  after: ExplainAnalysis,
  validationType: ValidationType = 'latency',
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

  const cautions: string[] = [];
  if (benchmarkSuitability === 'low-latency') {
    cautions.push(
      `Benchmark total time before the change was under ${MIN_LATENCY_IMPACT_BENCHMARK_MS}ms; do not frame this as a user-facing latency-impact finding without a slower representative query.`,
    );
  }
  if (before.plan.rootNodeType === after.plan.rootNodeType) {
    cautions.push(
      `The root plan node stayed ${before.plan.rootNodeType}; timing changes may reflect runtime variance rather than a clear plan-shape shift.`,
    );
  }

  if (timingOutcome === 'regressed') {
    cautions.push(
      'This tested change regressed the representative benchmark. Do not present it as a quick win or confirmed production fix for this workload.',
    );
  }

  if (validationType === 'config') {
    const beforeReadBlocks = before.plan.sharedReadBlocks;
    const afterReadBlocks = after.plan.sharedReadBlocks;
    const readBlockDelta =
      beforeReadBlocks !== null && afterReadBlocks !== null
        ? afterReadBlocks - beforeReadBlocks
        : null;
    const readBlockDeltaPct =
      readBlockDelta !== null &&
      beforeReadBlocks !== null &&
      beforeReadBlocks > 0
        ? (readBlockDelta / beforeReadBlocks) * 100
        : null;

    if (timingOutcome === 'regressed') {
      return {
        timingOutcome,
        recommendationStatus: 'rejected',
        benchmarkSuitability,
        rationale: `The tested configuration change made the representative benchmark slower, from ${before.totalTimeMs.toFixed(3)}ms to ${after.totalTimeMs.toFixed(3)}ms total time.`,
        cautions,
      };
    }

    if (
      readBlockDelta !== null &&
      readBlockDeltaPct !== null &&
      readBlockDelta <= -100 &&
      readBlockDeltaPct <= -NEUTRAL_DELTA_PCT
    ) {
      return {
        timingOutcome,
        recommendationStatus: 'validated',
        benchmarkSuitability,
        rationale: `The tested configuration change materially reduced shared read blocks by ${Math.abs(readBlockDelta)} (${Math.abs(readBlockDeltaPct).toFixed(2)}%) on the representative benchmark.`,
        cautions,
      };
    }

    cautions.push(
      'Configuration validation requires a material shared-read-block improvement; timing-only changes may be cache variance.',
    );
    return {
      timingOutcome,
      recommendationStatus: 'inconclusive',
      benchmarkSuitability,
      rationale:
        'The tested configuration change did not produce a material I/O improvement on the representative benchmark.',
      cautions,
    };
  }

  if (validationType === 'maintenance') {
    if (timingOutcome === 'regressed') {
      return {
        timingOutcome,
        recommendationStatus: 'rejected',
        benchmarkSuitability,
        rationale: `The tested maintenance operation completed, but the representative benchmark regressed from ${before.totalTimeMs.toFixed(3)}ms to ${after.totalTimeMs.toFixed(3)}ms total time.`,
        cautions,
      };
    }

    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale:
        timingOutcome === 'improved'
          ? 'The tested maintenance operation completed and improved the representative benchmark.'
          : 'The tested maintenance operation completed without regressing the representative benchmark.',
      cautions,
    };
  }

  if (timingOutcome === 'improved') {
    return {
      timingOutcome,
      recommendationStatus: 'validated',
      benchmarkSuitability,
      rationale:
        before.plan.rootNodeType === after.plan.rootNodeType
          ? 'The tested change improved the representative benchmark, but the plan root node did not change.'
          : `The tested change improved the representative benchmark and shifted the root plan node from ${before.plan.rootNodeType} to ${after.plan.rootNodeType}.`,
      cautions,
    };
  }

  if (timingOutcome === 'regressed') {
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

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.trim() !== '')));
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

function resolveGfsDumpsRoot(): string {
  const configuredRoot = process.env[GFS_DUMPS_DIR_ENV_VAR]?.trim();
  if (configuredRoot) {
    return configuredRoot;
  }

  const home = homedir();
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    return join(base, GFS_DUMPS_SUBDIR);
  }

  const base = process.env.XDG_CACHE_HOME ?? join(home, '.cache');
  return join(base, GFS_DUMPS_SUBDIR);
}

function sanitizeDumpName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePreparedDumpPath(input: {
  datasourceId: string;
  datasourceName: string;
  connectionUrl: string;
}): Promise<string> {
  const configuredFile = process.env[GFS_DUMP_FILE_ENV_VAR]?.trim();
  if (configuredFile) {
    if (await pathExists(configuredFile)) {
      return configuredFile;
    }
    throw new Error(
      `Configured ${GFS_DUMP_FILE_ENV_VAR} does not exist: ${configuredFile}`,
    );
  }

  const url = new URL(input.connectionUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const port = url.port || '5432';
  const host = url.hostname || 'localhost';
  const dumpRoot = resolveGfsDumpsRoot();
  const candidateNames = uniqueStrings([
    `${sanitizeDumpName(host)}-${port}-${sanitizeDumpName(database)}.sql`,
    `${sanitizeDumpName(input.datasourceName)}.sql`,
    `${sanitizeDumpName(input.datasourceId)}.sql`,
    `${sanitizeDumpName(database)}.sql`,
  ]);

  for (const candidateName of candidateNames) {
    const candidatePath = join(dumpRoot, candidateName);
    if (await pathExists(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(
    `No prepared GFS import dump found for datasource '${input.datasourceName}'. Expected one of ${candidateNames.map((name) => `'${join(dumpRoot, name)}'`).join(', ')}, or set ${GFS_DUMP_FILE_ENV_VAR} to an explicit SQL dump path. Create it with pg_dump --format=plain --no-owner --no-privileges --file <path> <connection-url>.`,
  );
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

function buildVersionedPsqlCandidates(majorVersion: string): string[] {
  return uniqueStrings([
    `psql-${majorVersion}`,
    `psql${majorVersion}`,
    `/usr/lib/postgresql/${majorVersion}/bin/psql`,
    `/usr/pgsql-${majorVersion}/bin/psql`,
    `/opt/homebrew/opt/libpq@${majorVersion}/bin/psql`,
    `/usr/local/opt/libpq@${majorVersion}/bin/psql`,
  ]);
}

function buildBootstrapPsqlCandidates(): string[] {
  return uniqueStrings([
    'psql',
    '/usr/bin/psql',
    '/usr/local/bin/psql',
    ...COMMON_POSTGRES_MAJOR_VERSIONS.flatMap((majorVersion) =>
      buildVersionedPsqlCandidates(majorVersion),
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

async function resolveBootstrapPsql(signal: AbortSignal): Promise<string> {
  const configuredBinary = process.env[PSQL_BIN_ENV_VAR]?.trim();
  if (configuredBinary) {
    const version = await tryReadCommandMajorVersion(configuredBinary, signal);
    if (!version) {
      throw new Error(
        `Configured PostgreSQL client '${configuredBinary}' from ${PSQL_BIN_ENV_VAR} was not executable.`,
      );
    }
    return configuredBinary;
  }

  for (const candidate of buildBootstrapPsqlCandidates()) {
    const version = await tryReadCommandMajorVersion(candidate, signal);
    if (version) {
      return candidate;
    }
  }

  throw new Error(
    `Could not find an executable psql binary. Install PostgreSQL client tools or set ${PSQL_BIN_ENV_VAR}.`,
  );
}

async function resolveVersionMatchedPsql(
  majorVersion: string,
  signal: AbortSignal,
): Promise<string> {
  const configuredBinary = process.env[PSQL_BIN_ENV_VAR]?.trim();

  if (configuredBinary) {
    const version = await tryReadCommandMajorVersion(configuredBinary, signal);
    if (!version) {
      throw new Error(
        `Configured PostgreSQL client '${configuredBinary}' from ${PSQL_BIN_ENV_VAR} was not executable.`,
      );
    }
    if (version !== majorVersion) {
      throw new Error(
        `Configured PostgreSQL client '${configuredBinary}' from ${PSQL_BIN_ENV_VAR} is version ${version}, but GFS validation requires PostgreSQL client major version ${majorVersion}.`,
      );
    }
    return configuredBinary;
  }

  for (const candidate of buildVersionedPsqlCandidates(majorVersion)) {
    const version = await tryReadCommandMajorVersion(candidate, signal);
    if (version === majorVersion) {
      return candidate;
    }
  }

  const defaultVersion = await tryReadCommandMajorVersion('psql', signal);
  if (defaultVersion === majorVersion) {
    return 'psql';
  }

  const mismatchHint = defaultVersion
    ? `The default 'psql' on PATH is PostgreSQL ${defaultVersion}.`
    : `No default 'psql' binary was found on PATH.`;

  throw new Error(
    `Could not find a PostgreSQL ${majorVersion}-compatible psql binary. ${mismatchHint} Install matching PostgreSQL client tools or set ${PSQL_BIN_ENV_VAR}.`,
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
): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < POSTGRES_READY_TIMEOUT_MS) {
    try {
      await runPsql(
        program,
        connectionUrl,
        'SELECT 1',
        signal,
        POSTGRES_READY_CHECK_TIMEOUT_MS,
      );
      return;
    } catch (error) {
      if (!isRetryablePostgresStartupError(error)) {
        throw error;
      }

      lastError =
        error instanceof Error ? error : new Error(String(error ?? 'unknown'));
      await waitForAbortableDelay(POSTGRES_READY_RETRY_DELAY_MS, signal);
    }
  }

  throw new Error(
    `Timed out waiting for the GFS PostgreSQL instance to accept connections after ${POSTGRES_READY_TIMEOUT_MS}ms. Last error: ${lastError?.message ?? 'unknown error'}`,
  );
}

async function runGfsImportWithRetry(
  repoPath: string,
  dumpPath: string,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = Date.now();
  let lastError: Error | null = null;

  while (Date.now() - startedAt < POSTGRES_READY_TIMEOUT_MS) {
    try {
      await runCommand(
        'gfs',
        ['import', '--file', dumpPath, '--format', 'sql'],
        { cwd: repoPath, signal },
      );
      return;
    } catch (error) {
      if (!isRetryablePostgresStartupError(error)) {
        throw error;
      }

      lastError =
        error instanceof Error ? error : new Error(String(error ?? 'unknown'));
      await waitForAbortableDelay(POSTGRES_READY_RETRY_DELAY_MS, signal);
    }
  }

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
  const bootstrapPsql = await resolveBootstrapPsql(signal);
  const majorVersion = await readPostgresMajorVersion(
    bootstrapPsql,
    connectionUrl,
    signal,
  );

  return {
    majorVersion,
    psql: await resolveVersionMatchedPsql(majorVersion, signal),
  };
}

async function ensureGfsBaselineRepo(input: {
  runDir: string;
  repoPath: string;
  connectionUrl: string;
  dumpPath: string;
  signal: AbortSignal;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<EnsuredGfsBaseline> {
  await rm(input.runDir, { recursive: true, force: true });
  await mkdir(input.repoPath, { recursive: true });

  const postgresClients = await resolvePostgresClientBinaries(
    input.connectionUrl,
    input.signal,
  );

  try {
    await runCommand(
      'gfs',
      [
        'init',
        '--database-provider',
        'postgres',
        '--database-version',
        postgresClients.majorVersion,
      ],
      { cwd: input.repoPath, signal: input.signal },
    );

    await runCommand('gfs', ['compute', 'start'], {
      cwd: input.repoPath,
      signal: input.signal,
    });

    const importStatus = await readGfsConnectionUrl(
      input.repoPath,
      input.signal,
    );
    await waitForPostgresReady(
      postgresClients.psql,
      importStatus.connectionUrl,
      input.signal,
    );
    await runGfsImportWithRetry(input.repoPath, input.dumpPath, input.signal);
    await runCommand(
      'gfs',
      ['commit', '-m', 'baseline snapshot before audit remediation'],
      { cwd: input.repoPath, signal: input.signal },
    );

    const checkpointCommit = await readLatestCommitHash(
      input.repoPath,
      input.signal,
    );

    return {
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
      psqlBinary: postgresClients.psql,
    };
  } catch (error) {
    input.logger.warn(
      {
        repoPath: input.repoPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to create GFS validation repo; removing partial run directory',
    );
    await rm(input.runDir, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup of partial run state.
    });
    throw error;
  }
}

export const __testables = {
  assessValidationResult,
  buildSessionScopedExplainSql,
  extractExplainJsonPayload,
  isRetryablePostgresStartupError,
  partitionActionStatements,
  parseExplainPlanSummary,
  parseCommitHash,
  parseExplainMetrics,
  runGfsValidationExclusive,
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
  const status = await readGfsStatus(repoPath, signal);
  const branchName = status.current_branch?.trim();

  if (branchName) {
    try {
      const refPath = join(repoPath, '.gfs', 'refs', 'heads', branchName);
      const refValue = (await readFile(refPath, 'utf8')).trim();
      if (isFullCommitHash(refValue)) {
        return refValue;
      }
    } catch {
      // Fall back to parsing `gfs log` output.
    }
  }

  const result = await runCommand('gfs', ['log', '--max-count', '1'], {
    cwd: repoPath,
    signal,
  });
  return parseCommitHash(result.stdout);
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
          'Use latency for query/schema remediations, config for PostgreSQL settings experiments, and maintenance for ANALYZE, VACUUM, or DROP INDEX operations.',
        ),
    }),
    async execute(params, ctx) {
      return runGfsValidationExclusive(async () => {
        assertExplainTargetSql(
          params.validationQuery,
          'validate_remediation_in_gfs_cli',
        );
        const actionStatements = params.actionStatements.map(
          normalizeActionStatement,
        );
        const partitionedStatements =
          partitionActionStatements(actionStatements);

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
        const dumpPath = await resolvePreparedDumpPath({
          datasourceId: datasource.id,
          datasourceName: datasource.name,
          connectionUrl,
        });
        const branchName = sanitizeBranchName(
          params.branchName ??
            `audit-${Date.now()}-${randomUUID().slice(0, 8)}`,
        );

        await ctx.metadata({
          title: 'Validate remediation with GFS CLI',
          metadata: {
            datasourceId: datasource.id,
            datasourceName: datasource.name,
            dumpPath,
            branchName,
          },
        });

        const workingRoot = resolveGfsAuditWorkingRoot();
        await mkdir(workingRoot, { recursive: true });
        const runsRoot = join(workingRoot, GFS_VALIDATION_RUNS_SUBDIR);
        await mkdir(runsRoot, { recursive: true });
        const runDir = join(
          runsRoot,
          `${datasource.id}-${Date.now()}-${randomUUID().slice(0, 8)}`,
        );
        const repoPath = join(runDir, 'repo');

        logger.info(
          {
            conversationId: ctx.conversationId,
            datasourceId: datasource.id,
            datasourceProvider: datasource.datasource_provider,
            branchName,
            dumpPath,
            repoPath,
          },
          'Starting GFS CLI remediation validation',
        );

        let shouldStopCompute = false;

        try {
          await runCommand('gfs', ['version'], { signal: ctx.abort });

          const baseline = await ensureGfsBaselineRepo({
            runDir,
            repoPath,
            connectionUrl,
            dumpPath,
            signal: ctx.abort,
            logger,
          });
          shouldStopCompute = true;

          await ctx.metadata({
            title: 'Created GFS validation repo',
            metadata: {
              runDir,
              repoPath,
              checkpointCommit: baseline.checkpointCommit,
              postgresMajorVersion: baseline.postgresMajorVersion,
              psqlBinary: baseline.psqlBinary,
              dumpPath,
            },
          });

          await runCommand(
            'gfs',
            ['checkout', '-b', branchName, baseline.checkpointCommit],
            {
              cwd: repoPath,
              signal: ctx.abort,
            },
          );

          const statusBefore = await readGfsConnectionUrl(repoPath, ctx.abort);
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

          for (const statement of partitionedStatements.persistentStatements) {
            await runPsqlWithRetry(
              baseline.psqlBinary,
              statusBefore.connectionUrl,
              statement,
              ctx.abort,
            );
          }

          if (partitionedStatements.persistentStatements.length > 0) {
            await runCommand(
              'gfs',
              ['commit', '-m', 'apply audit remediation candidate'],
              {
                cwd: repoPath,
                signal: ctx.abort,
              },
            );
          }

          const afterCommit = await readLatestCommitHash(repoPath, ctx.abort);
          const statusAfter = await readGfsConnectionUrl(repoPath, ctx.abort);
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
          );

          return {
            originalDatabaseUnchanged: true,
            datasource: {
              id: datasource.id,
              name: datasource.name,
              provider: datasource.datasource_provider,
            },
            gfs: {
              repoPath,
              branchName: statusAfter.branch,
              checkpointCommit: baseline.checkpointCommit,
              afterCommit,
              rollback: {
                restoreCheckpoint: `gfs checkout ${baseline.checkpointCommit}`,
                returnToBranch: `gfs checkout ${statusAfter.branch}`,
              },
            },
            validation: {
              validationType: params.validationType,
              query: params.validationQuery.trim(),
              actionsApplied: actionStatements,
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
              cwd: repoPath,
              timeoutMs: COMPUTE_STOP_TIMEOUT_MS,
            }).catch((error) => {
              logger.warn(
                {
                  repoPath,
                  error: error instanceof Error ? error.message : String(error),
                },
                'Failed to stop GFS compute after remediation validation',
              );
            });
          }
        }
      });
    },
  },
);
