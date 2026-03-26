import { execFile, type ExecFileException } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

function parseExplainMetrics(raw: string): ExplainMetrics {
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

  const planningTime = Number(
    (root as Record<string, unknown>)['Planning Time'] ?? 0,
  );
  const executionTime = Number(
    (root as Record<string, unknown>)['Execution Time'] ?? 0,
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
    { env, signal },
  );

  return result.stdout.trim();
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

export const __testables = {
  buildBootstrapBinaryCandidates,
  buildVersionedBinaryCandidates,
  parseCommitHash,
  parsePostgresClientMajorVersion,
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
          'SELECT or WITH query to benchmark before and after the remediation.',
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
      assertExplainTargetSql(params.validationQuery);
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

      const workingRoot = join(tmpdir(), 'qwery-gfs-audits');
      await mkdir(workingRoot, { recursive: true });
      const tempRoot = await mkdtemp(join(workingRoot, `${branchName}-`));
      const repoPath = join(tempRoot, 'repo');
      const dumpPath = join(tempRoot, 'baseline.sql');
      await mkdir(repoPath, { recursive: true });

      logger.info(
        {
          datasourceId: datasource.id,
          datasourceProvider: datasource.datasource_provider,
          branchName,
          repoPath,
        },
        'Starting GFS CLI remediation validation',
      );

      await runCommand('gfs', ['version'], { signal: ctx.abort });

      const postgresClients = await resolvePostgresClientBinaries(
        connectionUrl,
        ctx.abort,
      );

      await ctx.metadata({
        title: 'Resolved PostgreSQL client binaries',
        metadata: {
          postgresMajorVersion: postgresClients.majorVersion,
          psqlBinary: postgresClients.psql,
          pgDumpBinary: postgresClients.pgDump,
        },
      });

      await runCommand(
        postgresClients.pgDump,
        ['--format=plain', '--no-owner', '--no-privileges', '--file', dumpPath],
        {
          env: buildPostgresCliEnv(connectionUrl),
          signal: ctx.abort,
        },
      );

      await runCommand(
        'gfs',
        [
          'init',
          '--database-provider',
          'postgres',
          '--database-version',
          postgresClients.majorVersion,
        ],
        { cwd: repoPath, signal: ctx.abort },
      );

      await runCommand(
        'gfs',
        ['import', '--file', dumpPath, '--format', 'sql'],
        { cwd: repoPath, signal: ctx.abort },
      );
      await runCommand(
        'gfs',
        ['commit', '-m', 'baseline snapshot before audit remediation'],
        { cwd: repoPath, signal: ctx.abort },
      );

      const checkpointCommit = await readLatestCommitHash(repoPath, ctx.abort);

      await runCommand('gfs', ['checkout', '-b', branchName], {
        cwd: repoPath,
        signal: ctx.abort,
      });

      const statusBefore = await readGfsConnectionUrl(repoPath, ctx.abort);
      const before = parseExplainMetrics(
        await runPsql(
          postgresClients.psql,
          statusBefore.connectionUrl,
          buildExplainSql(params.validationQuery),
          ctx.abort,
        ),
      );

      const executedActions: string[] = [];
      for (const statement of actionStatements) {
        await runPsql(
          postgresClients.psql,
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
          cwd: repoPath,
          signal: ctx.abort,
        },
      );

      const afterCommit = await readLatestCommitHash(repoPath, ctx.abort);
      const statusAfter = await readGfsConnectionUrl(repoPath, ctx.abort);
      const after = parseExplainMetrics(
        await runPsql(
          postgresClients.psql,
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
          checkpointCommit,
          afterCommit,
          rollback: {
            restoreCheckpoint: `gfs checkout ${checkpointCommit}`,
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
        },
      };
    },
  },
);
