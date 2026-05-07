import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { stringFlag } from '../args';
import { CliError } from '../cli-error';
import { candidateDumpPaths, resolveDump } from '../dump';
import { redactUrl } from '../safety';

const execFileAsync = promisify(execFile);

export async function runDoctor(flags: Record<string, string | boolean>): Promise<void> {
  if (flags.help) {
    printDoctorHelp();
    return;
  }

  const url = stringFlag(flags, 'url');
  if (!url) throw new CliError('Missing required --url <postgres-url>.');

  const dump = stringFlag(flags, 'dump');
  const dumpDir = stringFlag(flags, 'dump-dir');
  const checks: Array<[string, boolean, string]> = [];

  checks.push(await binaryCheck('gfs'));
  checks.push(await binaryCheck(process.env.QWERY_PSQL_BIN ?? 'psql'));

  const dumpResolution = await resolveDump({ url, dump, dumpDir });
  checks.push(['dump', true, dumpResolution.selected ?? 'resolved']);

  const connection = await psqlConnectionCheck(url);
  checks.push(connection);

  console.log('DB Audit Doctor');
  console.log(`Datasource: ${redactUrl(url)}`);
  console.log(`Dump mode: ${dumpResolution.mode}`);
  console.log(`Selected dump: ${dumpResolution.selected}`);
  console.log('Candidate dump paths:');
  for (const candidate of dumpResolution.candidates.length > 0 ? dumpResolution.candidates : candidateDumpPaths(url)) {
    console.log(`- ${candidate}`);
  }
  console.log('Environment mapping:');
  for (const [key, value] of Object.entries(dumpResolution.env)) {
    console.log(`- ${key}=${value}`);
  }
  console.log('Checks:');
  for (const [name, ok, detail] of checks) {
    console.log(`- ${ok ? 'ok' : 'warn'} ${name}: ${detail}`);
  }
}

function printDoctorHelp(): void {
  console.log(`Usage: db-audit doctor --url <postgres-url> (--dump <path> | --dump-dir <path>)\n\nChecks local gfs/psql availability, dump readability, and PostgreSQL connectivity.`);
}

async function binaryCheck(binary: string): Promise<[string, boolean, string]> {
  try {
    await execFileAsync(binary, ['--version']);
    return [binary, true, 'available'];
  } catch (error) {
    const output = outputFromError(error);
    if (output.includes(binary) || output.toLowerCase().includes('version')) {
      return [binary, true, cleanVersionOutput(output)];
    }

    try {
      await execFileAsync('which', [binary]);
      return [binary, true, 'available'];
    } catch {
      // Fall through to the warning below.
    }

    return [binary, false, 'not found in PATH'];
  }
}

function cleanVersionOutput(output: string): string {
  return (output.split('\n')[0] ?? 'available').replace(/^error:\s*/i, '').trim() || 'available';
}

function outputFromError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const maybeOutput = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  return [maybeOutput.stdout, maybeOutput.stderr, maybeOutput.message]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .trim();
}

async function psqlConnectionCheck(url: string): Promise<[string, boolean, string]> {
  const psql = process.env.QWERY_PSQL_BIN ?? 'psql';
  try {
    await access(psql, constants.X_OK);
  } catch {
    // psql may still be resolvable through PATH.
  }

  try {
    const { stdout } = await execFileAsync(psql, [url, '-v', 'ON_ERROR_STOP=1', '-tAc', 'select version()'], { timeout: 15_000 });
    const version = stdout.trim().replace(/\s+/g, ' ');
    return ['postgres connection', true, version || 'connected'];
  } catch (error) {
    const message = error instanceof Error ? error.message : 'connection failed';
    return ['postgres connection', false, message.replaceAll(url, redactUrl(url))];
  }
}
