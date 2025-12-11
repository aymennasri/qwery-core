import {
  Task,
  TaskContent,
  TaskItem,
  TaskItemFile,
  TaskTrigger,
} from '../../ai-elements/task';
import {
  Message,
  MessageContent,
  MessageResponse,
  MessageActions,
  MessageAction,
} from '../../ai-elements/message';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '../../ai-elements/reasoning';
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from '../../ai-elements/tool';

import { SQLQueryVisualizer } from './sql-query-visualizer';

import { SchemaVisualizer } from './schema-visualizer';

import { AvailableSheetsVisualizer } from './sheets/available-sheets-visualizer';

import { ViewSheetVisualizer } from './sheets/view-sheet-visualizer';

import { ViewSheetError } from './sheets/view-sheet-error';
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from '../../ai-elements/sources';
import { useState } from 'react';
import { CopyIcon, RefreshCcwIcon, CheckIcon } from 'lucide-react';
import { ToolUIPart } from 'ai';
import { ToolErrorVisualizer } from './tool-error-visualizer';

import { ChartRenderer, type ChartConfig } from './charts/chart-renderer';

export type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'error';

export type TaskUIPart = {
  type: 'data-tasks';
  id: string;
  data: {
    title: string;
    subtitle?: string;
    tasks: {
      id: string;
      label: string;
      description?: string;
      status: TaskStatus;
    }[];
  };
};

export const TASK_STATUS_META: Record<
  TaskStatus,
  { label: string; badgeClass: string }
> = {
  pending: {
    label: 'Queued',
    badgeClass: 'bg-secondary text-foreground',
  },
  'in-progress': {
    label: 'Running',
    badgeClass: 'bg-primary/10 text-primary',
  },
  completed: {
    label: 'Done',
    badgeClass: 'bg-emerald-500/15 text-emerald-600',
  },
  error: {
    label: 'Error',
    badgeClass: 'bg-destructive/10 text-destructive',
  },
};

export interface TaskPartProps {
  part: TaskUIPart;
  messageId: string;
  index: number;
}

export function TaskPart({ part, messageId, index }: TaskPartProps) {
  return (
    <Task
      key={`${messageId}-${part.id}-${index}`}
      className="border-border bg-background/60 w-full border"
    >
      <TaskTrigger title={part.data.title} />
      <TaskContent>
        {part.data.subtitle ? (
          <p className="text-muted-foreground text-xs">{part.data.subtitle}</p>
        ) : null}
        {part.data.tasks.map((task) => {
          const meta = TASK_STATUS_META[task.status];
          return (
            <TaskItem
              key={task.id}
              className="text-foreground flex flex-col gap-1 text-sm"
            >
              <div className="flex items-center gap-2">
                <TaskItemFile className={meta.badgeClass}>
                  {meta.label}
                </TaskItemFile>
                <span>{task.label}</span>
              </div>
              {task.description ? (
                <p className="text-muted-foreground text-xs">
                  {task.description}
                </p>
              ) : null}
            </TaskItem>
          );
        })}
      </TaskContent>
    </Task>
  );
}

export interface TextPartProps {
  part: { type: 'text'; text: string };
  messageId: string;
  messageRole: 'user' | 'assistant' | 'system';
  index: number;
  isLastMessage: boolean;
  onRegenerate?: () => void;
}

export function TextPart({
  part,
  messageId,
  messageRole,
  index,
  isLastMessage,
  onRegenerate,
}: TextPartProps) {
  const [isCopied, setIsCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(part.text);
      setIsCopied(true);
      setTimeout(() => {
        setIsCopied(false);
      }, 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  return (
    <Message key={`${messageId}-${index}`} from={messageRole}>
      <MessageContent>
        <MessageResponse>{part.text}</MessageResponse>
      </MessageContent>
      {messageRole === 'assistant' && isLastMessage && (
        <MessageActions>
          {onRegenerate && (
            <MessageAction onClick={onRegenerate} label="Retry">
              <RefreshCcwIcon className="size-3" />
            </MessageAction>
          )}
          <MessageAction
            onClick={handleCopy}
            label={isCopied ? 'Copied!' : 'Copy'}
          >
            {isCopied ? (
              <CheckIcon className="size-3 text-green-600" />
            ) : (
              <CopyIcon className="size-3" />
            )}
          </MessageAction>
        </MessageActions>
      )}
    </Message>
  );
}

export interface ReasoningPartProps {
  part: { type: 'reasoning'; text: string };
  messageId: string;
  index: number;
  isStreaming: boolean;
}

export function ReasoningPart({
  part,
  messageId,
  index,
  isStreaming,
}: ReasoningPartProps) {
  return (
    <Reasoning
      key={`${messageId}-${index}`}
      className="w-full"
      isStreaming={isStreaming}
    >
      <ReasoningTrigger />
      <ReasoningContent>{part.text}</ReasoningContent>
    </Reasoning>
  );
}

export interface ToolPartProps {
  part: ToolUIPart;
  messageId: string;
  index: number;
}

export function ToolPart({ part, messageId, index }: ToolPartProps) {
  const toolName = part.type.replace('tool-', '');
  // Render specialized visualizers based on tool type
  const renderToolOutput = () => {
    // Handle errors with ToolErrorVisualizer
    if (part.state === 'output-error' && part.errorText) {
      return <ToolErrorVisualizer errorText={part.errorText} />;
    }

    // Handle runQuery tool with SQLQueryVisualizer
    if (part.type === 'tool-runQuery' && part.output) {
      const input = part.input as { query?: string } | null;
      const output = part.output as {
        result?: { columns: string[]; rows: Array<Record<string, unknown>> };
      } | null;
      return (
        <SQLQueryVisualizer
          query={input?.query}
          result={
            output?.result
              ? {
                  result: {
                    columns: output.result.columns,
                    rows: output.result.rows,
                  },
                }
              : undefined
          }
        />
      );
    }

    // Handle getSchema tool with SchemaVisualizer
    if (part.type === 'tool-getSchema' && part.output) {
      const output = part.output as {
        schema?: {
          databaseName: string;
          schemaName: string;
          tables: Array<{
            tableName: string;
            columns: Array<{ columnName: string; columnType: string }>;
          }>;
        };
      } | null;
      if (output?.schema) {
        return <SchemaVisualizer schema={output.schema} />;
      }
    }

    // Handle listAvailableSheets tool with AvailableSheetsVisualizer
    if (part.type === 'tool-listAvailableSheets' && part.output) {
      const output = part.output as {
        sheets?: Array<{
          name: string;
          type: 'view' | 'table' | 'attached_table';
        }>;
        count?: number;
      } | null;
      if (output?.sheets) {
        // Map tool output to visualizer format
        const mappedSheets = output.sheets.map((sheet) => ({
          name: sheet.name,
          type: sheet.type === 'attached_table' ? 'table' : sheet.type,
        }));
        return (
          <AvailableSheetsVisualizer
            data={{
              sheets: mappedSheets,
              message: `Found ${output.count ?? mappedSheets.length} sheet${(output.count ?? mappedSheets.length) !== 1 ? 's' : ''}`,
            }}
          />
        );
      }
    }

    // Handle viewSheet tool with ViewSheetVisualizer
    if (part.type === 'tool-viewSheet' && part.output) {
      const output = part.output as {
        sheetName?: string;
        columns?: string[];
        rows?: Array<Record<string, unknown>>;
        rowCount?: number;
        limit?: number;
        hasMore?: boolean;
      } | null;
      if (output?.sheetName && output?.columns && output?.rows !== undefined) {
        const displayedRows = output.rows.length;
        const totalRows = output.rowCount ?? displayedRows;
        return (
          <ViewSheetVisualizer
            data={{
              sheetName: output.sheetName,
              totalRows,
              displayedRows,
              columns: output.columns,
              rows: output.rows,
              message: output.hasMore
                ? `Showing first ${displayedRows} of ${totalRows} rows`
                : `Displaying all ${totalRows} rows`,
            }}
          />
        );
      }
    }

    // Handle viewSheet errors with ViewSheetError
    if (
      part.type === 'tool-viewSheet' &&
      part.state === 'output-error' &&
      part.errorText
    ) {
      const input = part.input as { sheetName?: string } | null;
      return (
        <ViewSheetError
          errorText={part.errorText}
          sheetName={input?.sheetName}
        />
      );
    }

    // Handle generateChart tool with ChartRenderer
    if (part.type === 'tool-generateChart' && part.output) {
      const output = part.output as ChartConfig | null;
      if (output?.chartType && output?.data && output?.config) {
        return <ChartRenderer chartConfig={output} />;
      }
    }

    // Default fallback to generic ToolOutput
    return <ToolOutput output={part.output} errorText={part.errorText} />;
  };

  return (
    <Tool
      key={`${messageId}-${index}`}
      defaultOpen={part.state === 'output-error'}
    >
      <ToolHeader title={toolName} type={part.type} state={part.state} />
      <ToolContent>
        {part.input != null ? <ToolInput input={part.input} /> : null}
        {renderToolOutput()}
      </ToolContent>
    </Tool>
  );
}

export interface SourcesPartProps {
  parts: Array<{ type: 'source-url'; sourceId: string; url?: string }>;
  messageId: string;
}

export function SourcesPart({ parts, messageId }: SourcesPartProps) {
  if (parts.length === 0) return null;

  return (
    <Sources>
      <SourcesTrigger count={parts.length} />
      {parts.map((part, i) => (
        <SourcesContent key={`${messageId}-${i}`}>
          <Source href={part.url} title={part.url} />
        </SourcesContent>
      ))}
    </Sources>
  );
}
