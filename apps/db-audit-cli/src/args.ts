export type CommandName = 'audit' | 'doctor' | 'help' | 'version';

export type ParsedArgs = {
  command: CommandName;
  flags: Record<string, string | boolean>;
  positionals: string[];
};

const aliases: Record<string, string> = {
  h: 'help',
  v: 'version',
};

export function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  const command = normalizeCommand(rawCommand);
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (!arg) continue;

    if (arg.startsWith('--')) {
      const withoutPrefix = arg.slice(2);
      const [rawKey, inlineValue] = withoutPrefix.split('=', 2);
      if (!rawKey) continue;

      const key = aliases[rawKey] ?? rawKey;
      if (inlineValue !== undefined) {
        flags[key] = inlineValue;
        continue;
      }

      const next = rest[index + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const key = aliases[arg.slice(1)] ?? arg.slice(1);
      flags[key] = true;
      continue;
    }

    positionals.push(arg);
  }

  return { command, flags, positionals };
}

function normalizeCommand(command?: string): CommandName {
  if (command === 'audit' || command === 'doctor' || command === 'version') return command;
  if (command === '--version' || command === '-v') return 'version';
  return 'help';
}

export function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function booleanFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
