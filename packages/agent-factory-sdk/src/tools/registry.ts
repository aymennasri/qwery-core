import { tool, jsonSchema } from 'ai';
import { z } from 'zod';
import type { Tool } from 'ai';
import type { ToolInfo, ToolContext, Model, ToolExecute } from './tool';
import type { AgentInfoWithId } from '../agents/agent';
import {
  AskAgent,
  QueryAgent,
  DbPerformanceAuditAgent,
  SlowQueryOptimizerAgent,
  CompactionAgent,
  SummaryAgent,
} from '../agents';
import { TodoWriteTool, TodoReadTool } from './todo';
import { WebFetchTool } from './webfetch';
import { GetSchemaTool } from './get-schema';
import { RunQueryTool } from './run-query';
import { RunQueriesTool } from './run-queries';
import { SelectChartTypeTool } from './select-chart-type-tool';
import { GenerateChartTool } from './generate-chart-tool';
import { GetSkillTool } from './get-skill';
import { TaskTool } from './task';
import { DetectDbEngineTool } from './detect-db-engine';
import { GetTopSlowQueriesTool } from './get-top-slow-queries';
import { ExplainQueryPlanTool } from './explain-query-plan';
import { CompareQueryRewriteTool } from './compare-query-rewrite';
import { GetIndexHealthTool } from './get-index-health';
import { GetTableHealthTool } from './get-table-health';
import { GetInfraRuntimeSignalsTool } from './get-infra-runtime-signals';
import { GetRecentDbLogsTool } from './get-recent-db-logs';
import { GetLockAndBlockingAnalysisTool } from './get-lock-and-blocking-analysis';
import { GetStatisticsHealthTool } from './get-statistics-health';
import { GetBloatEstimatesTool } from './get-bloat-estimates';
import { GetReplicationHealthTool } from './get-replication-health';
import { ValidateRemediationInGfsCliTool } from './validate-remediation-in-gfs-cli';
import { getLogger } from '@qwery/shared/logger';
import { getMcpTools } from '../mcp/client.js';
import type { McpServerConfig } from '../mcp/client.js';
import { GetTodoByConversationService } from '@qwery/domain/services';
import type { Repositories } from '@qwery/domain/repositories';

const TASK_COMPLETING_TOOL_IDS = new Set([
  'runQuery',
  'runQueries',
  'getSchema',
  'generateChart',
  'selectChartType',
]);

const TODO_REMINDER =
  '\n\n<system-reminder>You completed a task. Call todowrite to set that todo to completed and continue with the next one.</system-reminder>';

const todowriteInputSchema = jsonSchema<{
  todos: Array<{
    id: string;
    content: string;
    status: string;
    priority: string;
  }>;
}>({
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The updated todo list',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          content: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'content', 'status', 'priority'],
      },
    },
  },
  required: ['todos'],
});

const tools = new Map<string, ToolInfo>();
const agents = new Map<string, AgentInfoWithId>();

function registerTools() {
  tools.set(TodoWriteTool.id, TodoWriteTool as unknown as ToolInfo);
  tools.set(TodoReadTool.id, TodoReadTool as unknown as ToolInfo);
  tools.set(WebFetchTool.id, WebFetchTool as unknown as ToolInfo);
  tools.set(GetSchemaTool.id, GetSchemaTool as unknown as ToolInfo);
  tools.set(RunQueryTool.id, RunQueryTool as unknown as ToolInfo);
  tools.set(RunQueriesTool.id, RunQueriesTool as unknown as ToolInfo);
  tools.set(SelectChartTypeTool.id, SelectChartTypeTool as unknown as ToolInfo);
  tools.set(GenerateChartTool.id, GenerateChartTool as unknown as ToolInfo);
  tools.set(GetSkillTool.id, GetSkillTool as unknown as ToolInfo);
  tools.set(TaskTool.id, TaskTool as unknown as ToolInfo);
  tools.set(DetectDbEngineTool.id, DetectDbEngineTool as unknown as ToolInfo);
  tools.set(
    GetTopSlowQueriesTool.id,
    GetTopSlowQueriesTool as unknown as ToolInfo,
  );
  tools.set(
    ExplainQueryPlanTool.id,
    ExplainQueryPlanTool as unknown as ToolInfo,
  );
  tools.set(
    CompareQueryRewriteTool.id,
    CompareQueryRewriteTool as unknown as ToolInfo,
  );
  tools.set(GetIndexHealthTool.id, GetIndexHealthTool as unknown as ToolInfo);
  tools.set(GetTableHealthTool.id, GetTableHealthTool as unknown as ToolInfo);
  tools.set(
    GetInfraRuntimeSignalsTool.id,
    GetInfraRuntimeSignalsTool as unknown as ToolInfo,
  );
  tools.set(GetRecentDbLogsTool.id, GetRecentDbLogsTool as unknown as ToolInfo);
  tools.set(
    GetLockAndBlockingAnalysisTool.id,
    GetLockAndBlockingAnalysisTool as unknown as ToolInfo,
  );
  tools.set(
    GetStatisticsHealthTool.id,
    GetStatisticsHealthTool as unknown as ToolInfo,
  );
  tools.set(
    GetBloatEstimatesTool.id,
    GetBloatEstimatesTool as unknown as ToolInfo,
  );
  tools.set(
    GetReplicationHealthTool.id,
    GetReplicationHealthTool as unknown as ToolInfo,
  );
  tools.set(
    ValidateRemediationInGfsCliTool.id,
    ValidateRemediationInGfsCliTool as unknown as ToolInfo,
  );
}

function registerAgents() {
  agents.set(AskAgent.id, AskAgent);
  agents.set(QueryAgent.id, QueryAgent);
  agents.set(DbPerformanceAuditAgent.id, DbPerformanceAuditAgent);
  agents.set(SlowQueryOptimizerAgent.id, SlowQueryOptimizerAgent);
  agents.set(CompactionAgent.id, CompactionAgent);
  agents.set(SummaryAgent.id, SummaryAgent);
}

registerTools();
registerAgents();

export type GetContextOptions = {
  toolCallId?: string;
  abortSignal?: AbortSignal;
};

export type ForAgentOptions = {
  mcpServerUrl?: string;
  mcpNamePrefix?: string;
  webSearch?: boolean;
  mcpServers?: McpServerConfig[];
};

export type ForAgentResult = {
  tools: Record<string, Tool>;
  close?: () => Promise<void>;
};

async function resolveTool(
  info: ToolInfo,
  initCtx?: { agent?: { id: string } },
): Promise<{
  id: string;
  description: string;
  parameters: z.ZodType;
  execute: ToolExecute<z.ZodType>;
}> {
  if ('init' in info && typeof info.init === 'function') {
    const result = await info.init(initCtx);
    return { id: info.id, ...result };
  }
  const syncInfo = info as ToolInfo & {
    description: string;
    parameters: z.ZodType;
    execute: ToolExecute<z.ZodType>;
  };
  return {
    id: syncInfo.id,
    description: syncInfo.description,
    parameters: syncInfo.parameters,
    execute: syncInfo.execute,
  };
}

function whenModelMatches(info: ToolInfo, model: Model): boolean {
  const predicate = 'whenModel' in info ? info.whenModel : undefined;
  if (!predicate) return true;
  return predicate(model);
}

export const Registry = {
  tools: {
    register(t: ToolInfo) {
      tools.set(t.id, t);
    },
    list(): ToolInfo[] {
      return Array.from(tools.values());
    },
    get(id: string): ToolInfo | undefined {
      return tools.get(id);
    },
    async forAgent(
      agentId: string,
      model: Model,
      getContext: (options: GetContextOptions) => ToolContext,
      forAgentOptions?: ForAgentOptions,
    ): Promise<ForAgentResult> {
      const agent = agents.get(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      const allTools = Array.from(tools.values());
      const options = agent.options ?? {};
      const toolsMap = options.tools as Record<string, boolean> | undefined;
      const toolIds = options.toolIds as string[] | undefined;
      const toolDenylist = options.toolDenylist as string[] | undefined;

      let allowlist: string[] | undefined;
      if (toolsMap && toolsMap['*'] === false) {
        allowlist = Object.entries(toolsMap)
          .filter(([k, v]) => k !== '*' && v === true)
          .map(([k]) => k);
      } else if (toolIds?.length) {
        allowlist = toolIds;
      }

      let byAgent =
        allowlist != null
          ? allTools.filter((t) => allowlist!.includes(t.id))
          : allTools;
      if (toolDenylist?.length) {
        byAgent = byAgent.filter((t) => !toolDenylist.includes(t.id));
      }
      if (forAgentOptions?.webSearch === false) {
        byAgent = byAgent.filter((t) => t.id !== 'webfetch');
      }
      const byModel = byAgent.filter((t) => whenModelMatches(t, model));

      const result: Record<string, Tool> = {};
      const initCtx = { agent: { id: agentId } };

      for (const info of byModel) {
        const resolved = await resolveTool(info, initCtx);
        const inputSchema =
          resolved.id === 'todowrite'
            ? todowriteInputSchema
            : resolved.parameters;
        result[resolved.id] = tool({
          description: resolved.description,
          inputSchema,
          execute: async (args, options) => {
            resolved.parameters.parse(args);
            const context = getContext({
              toolCallId: options.toolCallId,
              abortSignal: options.abortSignal,
            });
            context.onToolStart?.(resolved.id, args, options.toolCallId ?? '');
            const startedAt = performance.now();
            let isError = false;
            let raw: Awaited<ReturnType<typeof resolved.execute>>;
            try {
              raw = await resolved.execute(args, context);
            } catch (error) {
              isError = true;
              throw error;
            } finally {
              const executionTimeMs = Number(
                (performance.now() - startedAt).toFixed(2),
              );
              context.onToolComplete?.(resolved.id, options.toolCallId ?? '', {
                executionTimeMs,
                isError,
              });
            }
            const toTruncate =
              typeof raw === 'string'
                ? raw
                : typeof raw === 'object' &&
                    raw !== null &&
                    'output' in raw &&
                    Object.keys(raw).length === 1
                  ? (raw as { output: string }).output
                  : null;
            let finalStr: string | null = null;
            let returnAsOutput = false;
            if (toTruncate != null) {
              try {
                const { truncateOutput } = await import('./truncation');
                const truncated = await truncateOutput(toTruncate);
                if (truncated.truncated) {
                  finalStr = truncated.content;
                  returnAsOutput =
                    typeof raw === 'object' &&
                    raw !== null &&
                    'output' in raw &&
                    Object.keys(raw).length === 1;
                }
              } catch {
                // truncation not available; fall through
              }
            }
            if (finalStr === null && typeof raw === 'string') {
              finalStr = raw;
            }
            if (
              finalStr === null &&
              typeof raw === 'object' &&
              raw !== null &&
              'output' in raw &&
              Object.keys(raw).length === 1
            ) {
              finalStr = (raw as { output: string }).output;
              returnAsOutput = true;
            }
            if (finalStr !== null) {
              if (
                TASK_COMPLETING_TOOL_IDS.has(resolved.id) &&
                context.extra?.repositories &&
                context.conversationId
              ) {
                const repos = context.extra.repositories as Repositories;
                const todoService = new GetTodoByConversationService(
                  repos.todo,
                  repos.conversation,
                );
                const todos = await todoService.execute({
                  conversationId: context.conversationId,
                });
                if (todos.some((t) => t.status === 'in_progress')) {
                  finalStr += TODO_REMINDER;
                }
              }
              return returnAsOutput ? { output: finalStr } : finalStr;
            }
            return raw as Record<string, unknown>;
          },
        });
      }

      const configuredMcpServers =
        forAgentOptions?.mcpServers && forAgentOptions.mcpServers.length > 0
          ? forAgentOptions.mcpServers
          : forAgentOptions?.mcpServerUrl
            ? [
                {
                  url: forAgentOptions.mcpServerUrl,
                  namePrefix: forAgentOptions.mcpNamePrefix,
                },
              ]
            : [];

      if (configuredMcpServers.length > 0) {
        const mergedTools = { ...result };
        const closeCallbacks: Array<() => Promise<void>> = [];

        for (const server of configuredMcpServers) {
          try {
            const { tools: mcpTools, close } = await getMcpTools(server.url, {
              headers: server.headers,
              namePrefix: server.namePrefix,
            });
            Object.assign(mergedTools, mcpTools);
            closeCallbacks.push(close);
          } catch (mcpError) {
            const logger = await getLogger();
            logger.warn(
              {
                err: mcpError,
                mcpServerUrl: server.url,
                message:
                  mcpError instanceof Error
                    ? mcpError.message
                    : String(mcpError),
              },
              'MCP server unavailable, continuing without MCP tools',
            );
          }
        }

        if (closeCallbacks.length > 0) {
          return {
            tools: mergedTools,
            close: async () => {
              await Promise.all(closeCallbacks.map((close) => close()));
            },
          };
        }

        return { tools: mergedTools };
      }

      return { tools: result };
    },
  },
  agents: {
    register(a: AgentInfoWithId) {
      agents.set(a.id, a);
    },
    list(): AgentInfoWithId[] {
      return Array.from(agents.values());
    },
    get(id: string): AgentInfoWithId | undefined {
      return agents.get(id);
    },
  },
};
