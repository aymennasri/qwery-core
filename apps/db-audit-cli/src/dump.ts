import { access, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, platform } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { CliError } from './cli-error';

export type DumpOptions = {
  url: string;
  dump?: string;
  dumpDir?: string;
};

export type DumpResolution = {
  env: Record<string, string>;
  candidates: string[];
  selected?: string;
  mode: 'file' | 'directory';
};

export async function resolveDump(options: DumpOptions): Promise<DumpResolution> {
  parsePostgresUrl(options.url);

  if (options.dump && options.dumpDir) {
    throw new CliError('Use only one of --dump or --dump-dir.');
  }

  if (options.dump) {
    const selected = resolve(options.dump);
    await assertReadableFile(selected, 'Dump file');
    await assertPlainSqlDump(selected);
    return {
      mode: 'file',
      selected,
      candidates: [selected],
      env: { QWERY_GFS_DUMP_FILE: selected },
    };
  }

  const dumpDir = resolve(options.dumpDir ?? process.env.QWERY_GFS_DUMPS_DIR ?? defaultDumpDir());
  await assertReadableDirectory(dumpDir, 'Dump directory');
  const candidates = candidateDumpPaths(options.url, dumpDir);
  const selected = await firstReadableFile(candidates);

  if (!selected) {
    throw new CliError(missingDumpMessage(dumpDir, candidates));
  }

  await assertPlainSqlDump(selected);
  return {
    mode: 'directory',
    selected,
    candidates,
    env: { QWERY_GFS_DUMPS_DIR: dumpDir },
  };
}

export function candidateDumpPaths(url: string, dumpDir = defaultDumpDir()): string[] {
  const parsed = parsePostgresUrl(url);
  const names = new Set<string>();
  names.add(`${parsed.host}-${parsed.port}-${parsed.database}.sql`);
  names.add(`${parsed.database}.sql`);
  return [...names].map((name) => join(dumpDir, name));
}

export function defaultDumpDir(): string {
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA ?? homedir(), 'qwery', 'gfs-dumps');
  }
  return join(homedir(), '.cache', 'qwery', 'gfs-dumps');
}

export function pgDumpCommand(outputPath = './prod-snapshot.sql'): string {
  return `pg_dump "$POSTGRES_URL" --format=plain --no-owner --no-privileges --file ${outputPath}`;
}

async function assertReadableFile(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isFile()) throw new Error('not a file');
    await access(path, constants.R_OK);
  } catch {
    throw new CliError(`${label} is not readable: ${path}\nCreate one with: ${pgDumpCommand(path)}`);
  }
}

async function assertReadableDirectory(path: string, label: string): Promise<void> {
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) throw new Error('not a directory');
    await readdir(path);
  } catch {
    throw new CliError(`${label} is not readable: ${path}\nCreate it and place a plain SQL dump in it.`);
  }
}

async function assertPlainSqlDump(path: string): Promise<void> {
  if (basename(path).endsWith('.dump')) {
    throw new CliError(`Dump must be plain SQL for GFS import --format sql: ${path}\nCreate one with: ${pgDumpCommand(path.replace(/\.dump$/, '.sql'))}`);
  }
}

async function firstReadableFile(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const stats = await stat(path);
      if (stats.isFile()) return path;
    } catch {
      // Keep checking the remaining GFS-compatible candidate names.
    }
  }
  return undefined;
}

function parsePostgresUrl(url: string): { host: string; port: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError('Invalid --url. Expected a PostgreSQL connection URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new CliError(`Unsupported datasource protocol: ${parsed.protocol}. Expected postgres:// or postgresql://.`);
  }

  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!parsed.hostname || !database) {
    throw new CliError('PostgreSQL URL must include host and database name.');
  }

  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
  };
}

function missingDumpMessage(dumpDir: string, candidates: string[]): string {
  return [
    `No prepared plain SQL dump found in ${dumpDir}.`,
    'Looked for:',
    ...candidates.map((candidate) => `- ${candidate}`),
    `Create one with: ${pgDumpCommand('./prod-snapshot.sql')}`,
    'Then pass --dump ./prod-snapshot.sql or copy it to one of the candidate paths.',
  ].join('\n');
}
