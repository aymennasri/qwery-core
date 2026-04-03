import { execFile, type ExecFileException } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  rm,
  stat,
  unlink,
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
const VERSION_CHECK_TIMEOUT_MS = 30 * 1000;
const COMPUTE_STOP_TIMEOUT_MS = 30 * 1000;
const POSTGRES_READY_TIMEOUT_MS = 60 * 1000;
const POSTGRES_READY_RETRY_DELAY_MS = 1000;
const POSTGRES_READY_CHECK_TIMEOUT_MS = 5000;
const GFS_AUDIT_ROOT_ENV_VAR = 'QWERY_GFS_AUDITS_DIR';
const GFS_AUDIT_ROOT_SUBDIR = 'qwery/gfs-audits';
const GFS_BASELINE_CACHE_SUBDIR = 'baselines';
const GFS_BASELINE_METADATA_FILENAME = 'baseline.json';
const GFS_BASELINE_LOCK_STALE_MS = 15 * 60 * 1000;
const GFS_BASELINE_LOCK_WAIT_TIMEOUT_MS = 2 * 60 * 1000;
const GFS_BASELINE_LOCK_WAIT_STEP_MS = 500;
const MIN_LATENCY_IMPACT_BENCHMARK_MS = 5;
const NEUTRAL_DELTA_ABS_MS = 1;
const NEUTRAL_DELTA_PCT = 10;
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

type GfsStatusResponse = {
  current_branch: string;
  compute?: {
    connection_string: string;
  } | null;
};

type ResolvedPostgresClientBinaries = {
  psql: string;
  pgDump: string;
  majorVersion: string;
};

type GfsBaselineMetadata = {
  checkpointCommit: string;
  postgresMajorVersion: string;
  createdAt: string;
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

function parseExplainRoot(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('EXPLAIN ANALYZE returned no output.');
  }

  const parsed = JSON.parse(trimmed) as unknown;
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

  const planningTime = Number(
    root['Planning Time'] ?? 0,
  );
  const executionTime = Number(
    root['Execution Time'] ?? 0,
  );

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

function isPermissionDeniedError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EACCES' || code === 'EPERM';
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

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function buildBaselineCacheKey(input: {
  conversationId: string;
  datasourceId: string;
  connectionUrl: string;
}): string {
  return `${input.datasourceId}-${hashText(
    `${input.conversationId}:${input.connectionUrl}`,
  )}`;
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
): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < GFS_BASELINE_LOCK_WAIT_TIMEOUT_MS) {
    try {
      await mkdir(lockDir);
      try {
        return await fn();
      } finally {
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
        const lockStat = await stat(lockDir);
        if (Date.now() - lockStat.mtimeMs > GFS_BASELINE_LOCK_STALE_MS) {
          await rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // The lock may have been released between stat attempts.
      }

      await waitForAbortableDelay(GFS_BASELINE_LOCK_WAIT_STEP_MS, signal);
    }
  }

  throw new Error('Timed out waiting for the cached GFS baseline lock.');
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
    return JSON.parse(await readFile(metadataPath, 'utf8')) as GfsBaselineMetadata;
  } catch {
    return null;
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
  if (!(await pathExists(input.repoPath))) {
    return null;
  }

  try {
    const postgresClients = await resolvePostgresClientBinaries(
      input.connectionUrl,
      input.signal,
    );
    const checkpointCommit = await readLatestCommitHash(input.repoPath, input.signal);
    const metadata: GfsBaselineMetadata = {
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
      createdAt: new Date().toISOString(),
    };
    await writeFile(input.metadataPath, JSON.stringify(metadata, null, 2), 'utf8');

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
  try {
    await rm(input.cacheDir, { recursive: true, force: true });
    return {
      cacheDir: input.cacheDir,
      repoPath: join(input.cacheDir, 'repo'),
      metadataPath: join(input.cacheDir, GFS_BASELINE_METADATA_FILENAME),
    };
  } catch (error) {
    if (!isPermissionDeniedError(error)) {
      throw error;
    }

    const fallbackCacheDir = `${input.cacheDir}-rebuild-${randomUUID().slice(0, 8)}`;
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

async function ensureGfsBaselineRepo(input: {
  cacheDir: string;
  repoPath: string;
  metadataPath: string;
  connectionUrl: string;
  signal: AbortSignal;
  logger: Awaited<ReturnType<typeof getLogger>>;
}): Promise<EnsuredGfsBaseline> {
  const existingMetadata = await readBaselineMetadata(input.metadataPath);
  if (existingMetadata && (await pathExists(input.repoPath))) {
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

  const postgresClients = await resolvePostgresClientBinaries(
    input.connectionUrl,
    input.signal,
  );
  const dumpPath = join(
    freshLocation.cacheDir,
    `baseline-${randomUUID().slice(0, 8)}.sql`,
  );

  await runCommand(
    postgresClients.pgDump,
    ['--format=plain', '--no-owner', '--no-privileges', '--file', dumpPath],
    {
      env: buildPostgresCliEnv(input.connectionUrl),
      signal: input.signal,
    },
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
      { cwd: freshLocation.repoPath, signal: input.signal },
    );

    await runCommand('gfs', ['compute', 'start'], {
      cwd: freshLocation.repoPath,
      signal: input.signal,
    });

    const importStatus = await readGfsConnectionUrl(
      freshLocation.repoPath,
      input.signal,
    );
    await waitForPostgresReady(
      postgresClients.psql,
      importStatus.connectionUrl,
      input.signal,
    );
    await runGfsImportWithRetry(freshLocation.repoPath, dumpPath, input.signal);
    await runCommand(
      'gfs',
      ['commit', '-m', 'baseline snapshot before audit remediation'],
      { cwd: freshLocation.repoPath, signal: input.signal },
    );

    const checkpointCommit = await readLatestCommitHash(
      freshLocation.repoPath,
      input.signal,
    );
    const metadata: GfsBaselineMetadata = {
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
      createdAt: new Date().toISOString(),
    };
    await writeFile(
      freshLocation.metadataPath,
      JSON.stringify(metadata, null, 2),
      'utf8',
    );

    return {
      cacheDir: freshLocation.cacheDir,
      repoPath: freshLocation.repoPath,
      checkpointCommit,
      postgresMajorVersion: postgresClients.majorVersion,
      psqlBinary: postgresClients.psql,
      pgDumpBinary: postgresClients.pgDump,
      reused: false,
      computeRunning: true,
    };
  } catch (error) {
    input.logger.warn(
      {
        repoPath: freshLocation.repoPath,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to create cached GFS baseline repo; removing partial cache',
    );
    await rm(freshLocation.cacheDir, { recursive: true, force: true }).catch(() => {
      // Best-effort cleanup of partial cache state.
    });
    throw error;
  } finally {
    await unlink(dumpPath).catch(() => {
      // Best-effort dump cleanup.
    });
  }
}

async function resolveAvailableBranchName(
  repoPath: string,
  requestedBranchName: string,
): Promise<string> {
  const refPath = join(repoPath, '.gfs', 'refs', 'heads', requestedBranchName);
  if (!(await pathExists(refPath))) {
    return requestedBranchName;
  }

  return buildBranchNameWithSuffix(
    requestedBranchName,
    randomUUID().slice(0, 8),
  );
}

export const __testables = {
  assessValidationResult,
  buildBaselineCacheKey,
  buildBranchNameWithSuffix,
  buildBootstrapBinaryCandidates,
  buildVersionedBinaryCandidates,
  isRetryablePostgresStartupError,
  parseExplainPlanSummary,
  parseCommitHash,
  parseExplainMetrics,
  parsePostgresClientMajorVersion,
  resolveGfsAuditWorkingRoot,
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
    }),
    async execute(params, ctx) {
      assertExplainTargetSql(
        params.validationQuery,
        'validate_remediation_in_gfs_cli',
      );
      const actionStatements = params.actionStatements.map(
        normalizeActionStatement,
      );

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
        conversationId: ctx.conversationId,
        datasourceId: datasource.id,
        connectionUrl,
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

      return withDirectoryLock(lockDir, ctx.abort, async () => {
        let shouldStopCompute = false;
        let activeRepoPath = repoPath;

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

          await ctx.metadata({
            title: baseline.reused
              ? 'Reused cached GFS baseline repo'
              : 'Created cached GFS baseline repo',
            metadata: {
              cacheKey,
              cacheDir: baseline.cacheDir,
              repoPath: activeRepoPath,
              checkpointCommit: baseline.checkpointCommit,
              postgresMajorVersion: baseline.postgresMajorVersion,
              psqlBinary: baseline.psqlBinary,
              pgDumpBinary: baseline.pgDumpBinary,
            },
          });

          const effectiveBranchName = await resolveAvailableBranchName(
            activeRepoPath,
            branchName,
          );
          if (effectiveBranchName !== branchName) {
            await ctx.metadata({
              title: 'Adjusted GFS branch name',
              metadata: {
                requestedBranchName: branchName,
                branchName: effectiveBranchName,
              },
            });
          }

          await runCommand(
            'gfs',
            ['checkout', '-b', effectiveBranchName, baseline.checkpointCommit],
            {
              cwd: activeRepoPath,
              signal: ctx.abort,
            },
          );

          if (!baseline.computeRunning) {
            await runCommand('gfs', ['compute', 'start'], {
              cwd: activeRepoPath,
              signal: ctx.abort,
            });
            shouldStopCompute = true;
          }

          const statusBefore = await readGfsConnectionUrl(activeRepoPath, ctx.abort);
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

          const executedActions: string[] = [];
          for (const statement of actionStatements) {
            await runPsqlWithRetry(
              baseline.psqlBinary,
              statusBefore.connectionUrl,
              statement,
              ctx.abort,
            );
            executedActions.push(statement);
          }

          await runCommand(
            'gfs',
            ['commit', '-m', 'apply audit remediation candidate'],
            {
              cwd: activeRepoPath,
              signal: ctx.abort,
            },
          );

          const afterCommit = await readLatestCommitHash(activeRepoPath, ctx.abort);
          const statusAfter = await readGfsConnectionUrl(activeRepoPath, ctx.abort);
          await waitForPostgresReady(
            baseline.psqlBinary,
            statusAfter.connectionUrl,
            ctx.abort,
          );
          const after = parseExplainAnalysis(
            await runPsqlWithRetry(
              baseline.psqlBinary,
              statusAfter.connectionUrl,
              buildExplainSql(params.validationQuery),
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
          const assessment = assessValidationResult(before, after);

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
