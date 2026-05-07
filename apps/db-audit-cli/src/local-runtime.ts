import { randomUUID } from 'node:crypto';

import { runAgentToCompletion } from '@qwery/agent-factory-sdk';
import { DatasourceKind, type Conversation, type Datasource, type Project } from '@qwery/domain/entities';
import type { Repositories } from '@qwery/domain/repositories';
import { ExtensionsRegistry, ExtensionScope, type DatasourceExtension } from '@qwery/extensions-sdk';
import { registerDriverImport } from '@qwery/extensions-loader';
import { driverFactory as postgresDriverFactory } from '@qwery/extension-postgresql';
import {
  ConversationRepository,
  DatasourceRepository,
  MessageRepository,
  NotebookRepository,
  OrganizationRepository,
  ProjectRepository,
  TodoRepository,
  UsageRepository,
  UserRepository,
} from '@qwery/repository-in-memory';
import type { UIMessage } from 'ai';

export type AuditRuntimeInput = {
  url: string;
  model?: string;
  statementTimeout: string;
  maxPlanCandidates: number;
  maxValidations: number;
  onToolMetadata?: (metadata: unknown) => void;
};

export type AuditRuntimeResult = {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

const POSTGRES_DRIVER_ID = 'postgresql.default';

export async function runDbPerformanceAudit(
  input: AuditRuntimeInput,
): Promise<AuditRuntimeResult> {
  registerPostgresExtension();

  const ids = {
    user: randomUUID(),
    organization: randomUUID(),
    project: randomUUID(),
    datasource: randomUUID(),
    conversation: randomUUID(),
    task: randomUUID(),
  };
  const now = new Date();
  const repositories = createRepositories();

  await repositories.project.create({
    id: ids.project,
    organizationId: ids.organization,
    name: 'DB Audit CLI',
    description: 'Standalone DB performance audit runtime',
    slug: 'db-audit-cli',
    createdAt: now,
    updatedAt: now,
    createdBy: ids.user,
    updatedBy: ids.user,
  } as Project);

  await repositories.datasource.create({
    id: ids.datasource,
    projectId: ids.project,
    name: 'postgres-audit-target',
    description: 'Temporary PostgreSQL datasource for standalone audit',
    slug: 'postgres-audit-target',
    datasource_provider: 'postgresql',
    datasource_driver: POSTGRES_DRIVER_ID,
    datasource_kind: DatasourceKind.REMOTE,
    config: { connectionUrl: input.url },
    createdAt: now,
    updatedAt: now,
    createdBy: ids.user,
    updatedBy: ids.user,
    isPublic: false,
  } satisfies Datasource);

  await repositories.conversation.create({
    id: ids.conversation,
    projectId: ids.project,
    taskId: ids.task,
    title: 'DB performance audit',
    slug: 'db-performance-audit-cli',
    createdAt: now,
    updatedAt: now,
    createdBy: ids.user,
    updatedBy: ids.user,
    datasources: [ids.datasource],
    isPublic: false,
  } as Conversation);

  const prompt = buildAuditPrompt(input);
  const messages: UIMessage[] = [
    {
      id: randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: prompt }],
    },
  ];

  return runAgentToCompletion({
    conversationId: ids.conversation,
    conversationSlug: 'db-performance-audit-cli',
    messages,
    agentId: 'db-performance-audit',
    model: input.model,
    repositories,
    abortSignal: new AbortController().signal,
    datasources: [ids.datasource],
    maxSteps: 80,
    onToolMetadata: input.onToolMetadata,
  });
}

function createRepositories(): Repositories {
  return {
    user: new UserRepository(),
    organization: new OrganizationRepository(),
    project: new ProjectRepository(),
    datasource: new DatasourceRepository(),
    notebook: new NotebookRepository(),
    conversation: new ConversationRepository(),
    message: new MessageRepository(),
    usage: new UsageRepository(),
    todo: new TodoRepository(),
  };
}

function registerPostgresExtension(): void {
  registerDriverImport(POSTGRES_DRIVER_ID, async () => ({
    driverFactory: postgresDriverFactory,
  }));

  if (!ExtensionsRegistry.get('postgresql')) {
    const extension: DatasourceExtension = {
      id: 'postgresql',
      name: 'PostgreSQL',
      icon: '',
      description: 'Connect to PostgreSQL databases',
      scope: ExtensionScope.DATASOURCE,
      schema: null,
      docsUrl: 'https://www.postgresql.org/docs/current/libpq-connect.html',
      supportsPreview: false,
      tags: ['SQL'],
      drivers: [
        {
          id: POSTGRES_DRIVER_ID,
          name: 'PostgreSQL (Node)',
          description: 'Default Node runtime PostgreSQL driver',
          runtime: 'node',
          entry: './dist/driver.js',
        },
      ],
    };
    ExtensionsRegistry.register(extension as Parameters<typeof ExtensionsRegistry.register>[0]);
  }
}

function buildAuditPrompt(input: AuditRuntimeInput): string {
  return [
    'Run a full PostgreSQL performance audit for the attached datasource using the db-performance-audit workflow.',
    `Use statement_timeout guidance of ${input.statementTimeout}.`,
    `Consider at most ${input.maxPlanCandidates} plan candidates and at most ${input.maxValidations} GFS validations.`,
    'Use db_audit_diagnostics first, then db_audit_plan for selected candidates, then validate_remediation_in_gfs_cli for concrete remediation candidates.',
    'Do not mutate the original datasource. Run remediation SQL only through validate_remediation_in_gfs_cli.',
    'Return the final professional markdown audit report with findings, evidence, GFS validation metadata, rollback SQL, caveats, and an explicit original database unchanged guarantee.',
  ].join('\n');
}
