import type { Datasource } from '@qwery/domain/entities';
import type { Repositories } from '@qwery/domain/repositories';
import { getDriverInstance } from '@qwery/extensions-loader';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
  type DriverExtension,
} from '@qwery/extensions-sdk';
import type { ToolContext } from '../tool';

const ALLOWED_ROOT = /^(SELECT|WITH|EXPLAIN|SHOW)\b/i;
const DISALLOWED_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|VACUUM|COPY|MERGE|CALL|DO)\b/i;

export type AuditQueryResult = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

type DriverQueryInput = {
  datasource: Datasource;
  query: (sql: string) => Promise<AuditQueryResult>;
};

type ToolInfra = {
  repositories: Repositories;
  attachedDatasources: string[];
};

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n\r]*/g, ' ')
    .trim();
}

function stripQuotedLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/(\$[A-Za-z_][A-Za-z0-9_]*\$)[\s\S]*?\1/g, '$$')
    .replace(/\$\$[\s\S]*?\$\$/g, '$$');
}

function splitStatements(sql: string): string[] {
  return sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function assertReadOnlySql(sql: string): void {
  const normalized = stripComments(sql);
  if (!normalized) {
    throw new Error('SQL query cannot be empty.');
  }

  const statementForValidation = stripQuotedLiterals(normalized);
  const statements = splitStatements(statementForValidation);
  if (statements.length !== 1) {
    throw new Error('Only one SQL statement is allowed per audit tool call.');
  }

  const statement = statements[0] ?? '';
  if (!ALLOWED_ROOT.test(statement)) {
    throw new Error(
      'Only read-only SQL statements are allowed (SELECT, WITH, EXPLAIN, SHOW).',
    );
  }

  if (DISALLOWED_KEYWORDS.test(statement)) {
    throw new Error('Write-capable SQL keywords are blocked in audit tools.');
  }

  if (/^EXPLAIN\b/i.test(statement)) {
    const explainTarget = statement
      .replace(/^EXPLAIN\b/i, '')
      .replace(/^\s*\([^)]*\)/, '')
      .trim();
    if (!/^(SELECT|WITH)\b/i.test(explainTarget)) {
      throw new Error(
        'EXPLAIN is only allowed for SELECT/WITH statements in audit tools.',
      );
    }
  }
}

export type ResolvedDatasource = {
  id: string;
  datasource: Datasource;
};

async function resolveDatasource(
  repositories: Repositories,
  attachedDatasources: string[],
): Promise<ResolvedDatasource> {
  const resolved = await Promise.all(
    attachedDatasources.map(async (id) => ({
      id,
      datasource: await repositories.datasource.findById(id),
    })),
  );

  const available = resolved.filter(
    (entry): entry is ResolvedDatasource => !!entry.datasource,
  );

  if (available.length === 0) {
    throw new Error(
      `No attached datasources were found: ${attachedDatasources.join(', ')}`,
    );
  }

  const postgresDatasource = available.find(({ datasource }) =>
    isPostgresDatasource(datasource),
  );

  const firstDatasource = available[0];
  if (!firstDatasource) {
    throw new Error(
      `No attached datasources were found: ${attachedDatasources.join(', ')}`,
    );
  }

  return postgresDatasource ?? firstDatasource;
}

export async function resolveAttachedDatasource(
  ctx: ToolContext,
): Promise<ResolvedDatasource> {
  const { repositories, attachedDatasources } = parseToolInfra(ctx);
  return resolveDatasource(repositories, attachedDatasources);
}

export function assertExplainTargetSql(
  sql: string,
  toolName = 'explain_query_plan',
): void {
  const normalized = stripComments(sql);
  if (!normalized) {
    throw new Error(`Query cannot be empty for ${toolName}.`);
  }

  if (!/^(SELECT|WITH)\b/i.test(normalized)) {
    throw new Error(
      `${toolName} only accepts SELECT or WITH queries as input. Use actionStatements for SET/RESET or other write-capable SQL.`,
    );
  }

  assertReadOnlySql(normalized);
}

function parseToolInfra(ctx: ToolContext): ToolInfra {
  if (!ctx.extra) {
    throw new Error('Tool context is missing required execution metadata.');
  }

  const repositories = (ctx.extra as { repositories?: Repositories })
    .repositories;
  if (!repositories) {
    throw new Error('Tool context does not include repositories.');
  }

  const attachedDatasources = (ctx.extra as { attachedDatasources?: string[] })
    .attachedDatasources;

  if (!attachedDatasources || attachedDatasources.length === 0) {
    throw new Error(
      'No datasource is attached. Attach a datasource and rerun the audit.',
    );
  }

  return { repositories, attachedDatasources };
}

export function toSafeLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  const rounded = Math.trunc(value);
  if (rounded <= 0) return fallback;
  return Math.min(rounded, max);
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function toString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    const firstLine = error.message.split('\n')[0]?.trim();
    return firstLine || 'unknown error';
  }
  return 'unknown error';
}

export function isPostgresDatasource(datasource: Datasource): boolean {
  const provider = datasource.datasource_provider.toLowerCase();
  return provider.includes('postgres');
}

export async function withDatasourceDriver<T>(
  ctx: ToolContext,
  fn: (input: DriverQueryInput) => Promise<T>,
): Promise<T> {
  const { repositories, attachedDatasources } = parseToolInfra(ctx);
  const { datasource } = await resolveDatasource(
    repositories,
    attachedDatasources,
  );

  const extension = ExtensionsRegistry.get(datasource.datasource_provider) as
    | DatasourceExtension
    | undefined;

  if (!extension?.drivers?.length) {
    throw new Error(
      `No driver found for provider: ${datasource.datasource_provider}`,
    );
  }

  const nodeDriver: DriverExtension | undefined =
    extension.drivers.find((driver) => driver.runtime === 'node') ??
    extension.drivers[0];

  if (!nodeDriver) {
    throw new Error(
      `No node driver for provider: ${datasource.datasource_provider}`,
    );
  }

  const instance = await getDriverInstance(nodeDriver, {
    config: datasource.config,
  });

  try {
    return await fn({
      datasource,
      query: async (sql: string) => {
        assertReadOnlySql(sql);
        const raw = await instance.query(sql);
        const columns = raw.columns.map((column) => {
          if (typeof column === 'string') {
            return column;
          }

          if (
            typeof column === 'object' &&
            column !== null &&
            'name' in column &&
            typeof (column as { name?: unknown }).name === 'string'
          ) {
            return (column as { name: string }).name;
          }

          return String(column);
        });

        const rows = raw.rows as Array<Record<string, unknown>>;
        return { columns, rows };
      },
    });
  } finally {
    if (typeof instance.close === 'function') {
      await instance.close();
    }
  }
}
