import { parseArgs } from './args';
import { CliError } from './cli-error';

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command === 'help') {
    printHelp();
    return;
  }

  if (command === 'version') {
    const { runVersion } = await import('./commands/version');
    await runVersion();
    return;
  }

  if (command === 'doctor') {
    const { runDoctor } = await import('./commands/doctor');
    await runDoctor(flags);
    return;
  }

  if (command === 'audit') {
    const { runAudit } = await import('./commands/audit');
    await runAudit(flags);
  }
}

function printHelp(): void {
  console.log(`Usage: db-audit <command> [options]\n\nCommands:\n  version                 Print CLI, git, agent, and tool version info\n  doctor --url <url>      Check local prerequisites and prepared dump\n  audit --url <url>       Write audit artifacts using an expert-provided dump\n\nCommon flags:\n  --dump <path>           Plain SQL dump path; maps to QWERY_GFS_DUMP_FILE\n  --dump-dir <path>       Dump directory; maps to QWERY_GFS_DUMPS_DIR\n  --gfs-audits-dir <path> GFS audit workdir; maps to QWERY_GFS_AUDITS_DIR\n  --out <path>            Markdown report path\n  --json <path>           JSON report path`);
}

main().catch((error: unknown) => {
  if (error instanceof CliError) {
    console.error(error.message);
    process.exitCode = error.exitCode;
    return;
  }

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(String(error));
  }
  process.exitCode = 1;
});
