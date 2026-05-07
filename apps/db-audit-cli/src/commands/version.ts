import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function runVersion(): Promise<void> {
  const pkg = await readPackageJson();
  const gitSha = await readGitSha();
  console.log(`db-audit ${pkg.version}`);
  console.log(`git ${gitSha}`);
  console.log('agent db-performance-audit');
  console.log('tools db_audit_diagnostics, db_audit_plan, validate_remediation_in_gfs_cli');
}

async function readPackageJson(): Promise<{ version: string }> {
  const packagePath = join(process.cwd(), 'apps', 'db-audit-cli', 'package.json');
  try {
    return JSON.parse(await readFile(packagePath, 'utf8')) as { version: string };
  } catch {
    return { version: '0.1.0' };
  }
}

async function readGitSha(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD']);
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}
