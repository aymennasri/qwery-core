'use server';

import {
  Experimental_Agent,
  stepCountIs,
  tool,
  convertToModelMessages,
} from 'ai';
import type { LanguageModel, UIMessage } from 'ai';
import { z } from 'zod';
import { fromPromise } from 'xstate/actors';
import { resolveModel } from '../../services';
import { testConnection } from '../../tools/test-connection';
import { gsheetToDuckdb } from '../../tools/gsheet-to-duckdb';
import { extractSchema } from '../../tools/extract-schema';
import type { SimpleSchema } from '@qwery/domain/entities';
import { runQuery } from '../../tools/run-query';
import { viewSheet } from '../../tools/view-sheet';
import { READ_DATA_AGENT_PROMPT } from '../prompts/read-data-agent.prompt';
import { buildBusinessContext } from '../../tools/build-business-context';
import { enhanceBusinessContextInBackground } from './enhance-business-context.actor';
import { generateChart, selectChartType } from '../tools/generate-chart';
import { ChartTypeSchema } from '../types/chart.types';
import { getSupportedChartTypes } from '../config/supported-charts';
import { renameSheet } from '../../tools/rename-sheet';
import { deleteSheet } from '../../tools/delete-sheet';
import {
  registerSheetView,
  loadViewRegistry,
  updateViewUsage,
  generateSemanticViewName,
  updateViewName,
  validateTableExists,
  cleanupOrphanedTempTables,
  deleteViewFromRegistry,
  getViewByName,
  renameView,
  type RegistryContext,
} from '../../tools/view-registry';
import { loadBusinessContext } from '../../tools/utils/business-context.storage';

export const readDataAgentActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      inputMessage: string;
      conversationId: string;
      previousMessages: UIMessage[];
    };
  }) => {
    const agent = new ReadDataAgent({
      conversationId: input.conversationId,
    });
    const agentInstance = await agent.getAgent();

    if (!input.inputMessage || typeof input.inputMessage !== 'string') {
      throw new Error('inputMessage must be a non-empty string');
    }

    const uiMessage: UIMessage = {
      id: '',
      role: 'user',
      parts: [{ type: 'text', text: input.inputMessage }],
    };

    const modelMessages = convertToModelMessages([uiMessage]);

    const result = agentInstance.stream({
      messages: modelMessages,
    });
    return result;
  },
);

// Lazy workspace resolution - only resolve when actually needed, not at module load time
// This prevents side effects when the module is imported in browser/SSR contexts
let WORKSPACE_CACHE: string | undefined;

function resolveWorkspaceDir(): string | undefined {
  const globalProcess =
    typeof globalThis !== 'undefined'
      ? (globalThis as { process?: NodeJS.Process }).process
      : undefined;
  const envValue =
    globalProcess?.env?.WORKSPACE ??
    globalProcess?.env?.VITE_WORKING_DIR ??
    globalProcess?.env?.WORKING_DIR;
  if (envValue) {
    return envValue;
  }

  try {
    return (import.meta as { env?: Record<string, string> })?.env
      ?.VITE_WORKING_DIR;
  } catch {
    return undefined;
  }
}

function getWorkspace(): string | undefined {
  if (WORKSPACE_CACHE === undefined) {
    WORKSPACE_CACHE = resolveWorkspaceDir();
  }
  return WORKSPACE_CACHE;
}

export interface ReadDataAgentOptions {
  conversationId: string;
}

export class ReadDataAgent {
  private agentPromise: Promise<
    ReturnType<ReadDataAgent['createAgent']>
  > | null = null;
  private readonly conversationId: string;

  constructor(opts: ReadDataAgentOptions) {
    this.conversationId = opts.conversationId;
  }

  /**
   * Sanitizes a string for safe logging to prevent format string and log injection attacks.
   * Removes control characters and limits length.
   */
  private sanitizeForLog(value: string): string {
    // Remove control characters and limit length to prevent log injection
    // eslint-disable-next-line no-control-regex -- Intentional: removing control chars for security
    return value.replace(/[\x00-\x1F\x7F-\x9F]/g, '').substring(0, 200);
  }

  async getAgent(): Promise<ReturnType<ReadDataAgent['createAgent']>> {
    if (!this.agentPromise) {
      this.agentPromise = this.initializeAgent();
    }
    return this.agentPromise;
  }

  private async initializeAgent(): Promise<
    ReturnType<ReadDataAgent['createAgent']>
  > {
    const model = await resolveModel('azure/gpt-5-mini');

    if (!isLanguageModel(model)) {
      throw new Error('AgentFactory resolved model is not a LanguageModel');
    }

    return this.createAgent(model);
  }

  private createAgent(model: LanguageModel) {
    return new Experimental_Agent({
      model,
      system: READ_DATA_AGENT_PROMPT,
      tools: {
        testConnection: tool({
          description:
            'Test the connection to the database to check if the database is accessible',
          inputSchema: z.object({}),
          execute: async () => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const dbPath = join(workspace, this.conversationId, 'database.db');
            const result = await testConnection({
              dbPath: dbPath,
            });
            return result.toString();
          },
        }),
        createDbViewFromSheet: tool({
          description:
            'Create View(s) from Google Sheet(s). Supports single or multiple sheets. If multiple links are provided (separated by |), process them all. Each sheet gets a unique semantic name automatically based on its content.',
          inputSchema: z.object({
            sharedLink: z
              .union([
                z
                  .string()
                  .describe(
                    'Single Google Sheet URL, or multiple URLs separated by | (pipe character)',
                  ),
                z
                  .array(z.string())
                  .describe('Array of Google Sheet URLs for batch creation'),
              ])
              .describe(
                'Google Sheet shared link/URL(s). Can be a single URL, multiple URLs separated by |, or an array of URLs.',
              ),
            sheetName: z
              .union([z.string(), z.array(z.string())])
              .optional()
              .describe(
                'Optional meaningful name(s) for the sheet(s). If not provided, semantic names will be generated automatically based on sheet content. For multiple sheets, provide array of names or omit for auto-naming.',
              ),
          }),
          execute: async ({ sharedLink, sheetName }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const { mkdir } = await import('node:fs/promises');
            await mkdir(workspace, { recursive: true });
            const fileDir = join(workspace, this.conversationId);
            await mkdir(fileDir, { recursive: true });
            const dbPath = join(fileDir, 'database.db');

            // Cleanup orphaned temp tables on startup
            await cleanupOrphanedTempTables(dbPath);

            const context: RegistryContext = {
              conversationDir: fileDir,
            };

            // Parse links: handle string with | separator or array
            let links: string[];
            if (Array.isArray(sharedLink)) {
              links = sharedLink;
            } else if (
              typeof sharedLink === 'string' &&
              sharedLink.includes('|')
            ) {
              links = sharedLink
                .split('|')
                .map((link) => link.trim())
                .filter(Boolean);
            } else {
              links = [sharedLink];
            }

            // Deduplicate links before processing (remove duplicates)
            // This prevents processing the same sheet multiple times
            const originalLinkCount = links.length;
            const uniqueLinks = [...new Set(links)];
            const duplicateCount = originalLinkCount - uniqueLinks.length;
            if (duplicateCount > 0) {
              console.debug('[ReadDataAgent] Removed duplicate link(s)', {
                conversationId: this.sanitizeForLog(this.conversationId),
                duplicateCount,
                uniqueLinksCount: uniqueLinks.length,
                originalLinkCount,
              });
            }
            links = uniqueLinks;

            // Parse sheet names: handle array or single string
            const names = Array.isArray(sheetName)
              ? sheetName
              : sheetName
                ? [sheetName]
                : [];

            const results: Array<{
              success: boolean;
              viewName?: string;
              displayName?: string;
              error?: string;
              link: string;
              schema?: SimpleSchema;
              errorDetails?: {
                stack?: string;
                type?: string;
              };
            }> = [];

            const existing = await loadViewRegistry(context);
            const existingNamesSet = new Set(existing.map((r) => r.viewName));

            // Sequential processing
            console.debug('[ReadDataAgent] Processing links sequentially', {
              conversationId: this.sanitizeForLog(this.conversationId),
              linkCount: links.length,
            });

            const existingNames = Array.from(existingNamesSet);

            for (let i = 0; i < links.length; i++) {
              const link = links[i];
              if (!link) continue;
              const providedName = names[i];

              try {
                // Extract sourceId from link
                const sourceId = link.match(
                  /https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/,
                )?.[1];
                const existingRecord = sourceId
                  ? existing.find((rec) => rec.sourceId === sourceId)
                  : null;

                if (existingRecord) {
                  // View exists in registry, validate it exists in DB
                  try {
                    const exists = await validateTableExists(
                      dbPath,
                      existingRecord.viewName,
                    );
                    if (exists) {
                      // Update usage and continue
                      await updateViewUsage(context, existingRecord.viewName);
                      results.push({
                        success: true,
                        viewName: existingRecord.viewName,
                        displayName: existingRecord.displayName,
                        link,
                      });
                      existingNames.push(existingRecord.viewName);
                      continue;
                    }
                  } catch (validateError) {
                    console.warn(
                      '[ReadDataAgent] Error validating existing view',
                      {
                        conversationId: this.sanitizeForLog(
                          this.conversationId,
                        ),
                        error: validateError,
                      },
                    );
                  }
                  // View in registry but not in DB - recreate it
                  console.debug(
                    '[ReadDataAgent] View in registry but missing in DB, recreating',
                    {
                      conversationId: this.sanitizeForLog(this.conversationId),
                      viewName: this.sanitizeForLog(existingRecord.viewName),
                    },
                  );
                  try {
                    await gsheetToDuckdb({
                      dbPath,
                      sharedLink: link,
                      viewName: existingRecord.viewName,
                    });
                    await updateViewUsage(context, existingRecord.viewName);
                    results.push({
                      success: true,
                      viewName: existingRecord.viewName,
                      displayName: existingRecord.displayName,
                      link,
                    });
                    continue;
                  } catch (recreateError) {
                    const errorMsg =
                      recreateError instanceof Error
                        ? recreateError.message
                        : String(recreateError);
                    throw new Error(
                      `Failed to recreate existing view: ${errorMsg}`,
                    );
                  }
                }

                // Generate temp name first
                const tempViewName = `temp_${Date.now()}_${Math.random()
                  .toString(36)
                  .substring(2, 8)}`;

                console.debug(
                  '[ReadDataAgent] Creating DuckDB view from sheet',
                  {
                    conversationId: this.sanitizeForLog(this.conversationId),
                    link: this.sanitizeForLog(link),
                  },
                );

                let schema;
                let finalViewName: string;

                try {
                  // Step 1: Create view in database
                  await gsheetToDuckdb({
                    dbPath,
                    sharedLink: link,
                    viewName: tempViewName,
                  });
                } catch (createError) {
                  const errorMsg =
                    createError instanceof Error
                      ? createError.message
                      : String(createError);
                  throw new Error(
                    `Failed to create database view: ${errorMsg}`,
                  );
                }

                try {
                  // Step 2: Extract schema from temp table (allow temp tables during creation)
                  schema = await extractSchema({
                    dbPath,
                    viewName: tempViewName,
                    allowTempTables: true,
                  });
                } catch (schemaError) {
                  const errorMsg =
                    schemaError instanceof Error
                      ? schemaError.message
                      : String(schemaError);
                  throw new Error(`Failed to extract schema: ${errorMsg}`);
                }

                try {
                  // Step 3: Determine final view name
                  if (providedName) {
                    // Sanitize provided name
                    finalViewName = providedName
                      .replace(/[^a-zA-Z0-9_]/g, '_')
                      .replace(/^([^a-zA-Z])/, 'v_$1')
                      .toLowerCase();
                  } else {
                    // Generate semantic name
                    finalViewName = generateSemanticViewName(
                      schema,
                      existingNames,
                    );
                  }

                  // Step 4: Rename in DB if different from temp name
                  if (finalViewName !== tempViewName) {
                    // Check if final name already exists (might be from a previous failed attempt)
                    const finalNameExists = await validateTableExists(
                      dbPath,
                      finalViewName,
                    );
                    if (finalNameExists) {
                      // If it exists, append a suffix to make it unique
                      let uniqueName = finalViewName;
                      let counter = 1;
                      while (await validateTableExists(dbPath, uniqueName)) {
                        uniqueName = `${finalViewName}_${counter}`;
                        counter++;
                      }
                      finalViewName = uniqueName;
                    }

                    await renameView(dbPath, tempViewName, finalViewName);
                  }
                } catch (nameError) {
                  const errorMsg =
                    nameError instanceof Error
                      ? nameError.message
                      : String(nameError);
                  throw new Error(
                    `Failed to determine or rename view: ${errorMsg}`,
                  );
                }

                // Update existing names list for next iteration
                existingNames.push(finalViewName);

                try {
                  // Step 5: Register in view registry
                  await registerSheetView(
                    context,
                    link,
                    finalViewName,
                    finalViewName, // displayName same as viewName for now
                    schema,
                  );
                } catch (registryError) {
                  const errorMsg =
                    registryError instanceof Error
                      ? registryError.message
                      : String(registryError);
                  throw new Error(
                    `Failed to register view in registry: ${errorMsg}`,
                  );
                }

                // Step 6: Build fast business context immediately (non-blocking)
                try {
                  await buildBusinessContext({
                    conversationDir: fileDir,
                    viewName: finalViewName,
                    schema,
                  });
                  // Trigger background enhancement (fire and forget)
                  try {
                    enhanceBusinessContextInBackground({
                      conversationDir: fileDir,
                      viewName: finalViewName,
                      schema,
                      dbPath,
                    });
                  } catch (bgError) {
                    console.warn(
                      '[ReadDataAgent] Background context enhancement failed',
                      {
                        conversationId: this.sanitizeForLog(
                          this.conversationId,
                        ),
                        error: bgError,
                      },
                    );
                  }
                } catch (contextError) {
                  // Non-critical - log but don't fail
                  console.warn(
                    '[ReadDataAgent] Failed to build business context',
                    {
                      conversationId: this.sanitizeForLog(this.conversationId),
                      error: contextError,
                    },
                  );
                }

                results.push({
                  success: true,
                  viewName: finalViewName,
                  displayName: finalViewName,
                  link,
                });
              } catch (error) {
                const errorMsg =
                  error instanceof Error ? error.message : String(error);
                const errorStack =
                  error instanceof Error ? error.stack : undefined;
                console.error(
                  '[ReadDataAgent] Failed to create view from sheet',
                  {
                    conversationId: this.sanitizeForLog(this.conversationId),
                    link: this.sanitizeForLog(link),
                    error,
                  },
                );
                results.push({
                  success: false,
                  error: errorMsg,
                  link,
                  errorDetails: errorStack
                    ? {
                        stack: errorStack,
                        type:
                          error instanceof Error
                            ? error.constructor.name
                            : typeof error,
                      }
                    : undefined,
                });
              }
            }

            // Build summary with detailed state tracking
            const successful = results.filter((r) => r.success);
            const failed = results.filter((r) => !r.success);

            // Determine overall status
            const overallStatus =
              successful.length === 0
                ? 'failed'
                : failed.length > 0
                  ? 'partial'
                  : 'success';

            // Build detailed results for each link
            const detailedResults = results.map((r) => ({
              link: r.link,
              status: r.success ? 'success' : 'error',
              viewName: r.viewName,
              displayName: r.displayName,
              error: r.error,
              errorDetails: r.errorDetails,
            }));

            // Build user-friendly message with deduplication info
            let message = '';
            const deduplicationInfo =
              duplicateCount > 0
                ? ` Found ${originalLinkCount} link(s), processed ${links.length} unique link(s) (${duplicateCount} duplicate(s) removed), and created ${successful.length} sheet(s).`
                : '';

            if (overallStatus === 'failed') {
              message = `Failed to create views from all provided Google Sheets.${deduplicationInfo} Errors: ${failed.map((f) => f.error).join('; ')}`;
            } else if (successful.length === 1) {
              const first = successful[0];
              if (!first?.viewName) {
                message = `Successfully created view from Google Sheet.${deduplicationInfo}`;
              } else {
                message = `Successfully created view "${first.viewName}" from Google Sheet.${deduplicationInfo} Use this viewName in your queries.`;
              }
            } else {
              // Multiple views created
              const viewList = successful
                .map((r) => {
                  if (!r.viewName || !r.link) return '';
                  return `${r.link} → ${r.viewName}${r.viewName !== r.displayName ? ` (${r.displayName})` : ''}`;
                })
                .filter(Boolean)
                .join('\n');

              message = `Successfully created ${successful.length} view(s) from Google Sheets.${deduplicationInfo}\n\n${viewList}`;
              if (failed.length > 0) {
                message += `\n\nFailed to create ${failed.length} view(s). Errors: ${failed.map((f) => f.error).join('; ')}`;
              }
              message +=
                '\n\nAll views are now available - you can ask questions about their data.';
            }

            return {
              content: message,
              status: overallStatus,
              results: detailedResults,
              summary: {
                total: results.length,
                successful: successful.length,
                failed: failed.length,
                viewNames: successful
                  .map((r) => r.viewName)
                  .filter((name): name is string => !!name),
              },
            };
          },
        }),
        listViews: tool({
          description:
            'List all available views (sheets) in the database. Returns views with their semantic names, display names, and metadata. CACHED: Results are cached for 1 minute. Only call when starting a new conversation or when user explicitly asks to refresh.',
          inputSchema: z.object({
            forceRefresh: z
              .boolean()
              .optional()
              .describe('Force refresh cache (defaults to false)'),
          }),
          execute: async ({ forceRefresh: _forceRefresh }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const context: RegistryContext = {
              conversationDir: fileDir,
            };

            const registry = await loadViewRegistry(context);
            return {
              views: registry.map((record) => ({
                viewName: record.viewName,
                displayName: record.displayName,
                sharedLink: record.sharedLink,
                sourceId: record.sourceId,
                createdAt: record.createdAt,
                updatedAt: record.updatedAt,
                lastUsedAt: record.lastUsedAt,
              })),
              message:
                registry.length === 0
                  ? 'No views are currently registered. Use createDbViewFromSheet to register a Google Sheet.'
                  : `Found ${registry.length} view(s). Use the viewName in SQL queries.`,
            };
          },
        }),
        renameSheet: tool({
          description:
            'Rename a sheet/view to a more meaningful name. Use this when you want to give a sheet a better name based on its content, schema, or user context. Updates both database and registry.',
          inputSchema: z.object({
            oldSheetName: z
              .string()
              .describe('Current name of the sheet/view to rename'),
            newSheetName: z
              .string()
              .describe(
                'New meaningful name for the sheet (use lowercase, numbers, underscores only)',
              ),
          }),
          execute: async ({ oldSheetName, newSheetName }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const dbPath = join(fileDir, 'database.db');
            const context: RegistryContext = {
              conversationDir: fileDir,
            };

            // Get view record to find sourceId
            const viewRecord = await getViewByName(context, oldSheetName);
            if (!viewRecord) {
              throw new Error(
                `View "${oldSheetName}" not found in registry. Use listViews to see available views.`,
              );
            }

            // Rename in database
            const result = await renameSheet({
              dbPath,
              oldSheetName,
              newSheetName,
            });

            // Update registry
            await updateViewName(
              context,
              viewRecord.sourceId,
              newSheetName,
              newSheetName, // displayName
            );

            return result;
          },
        }),
        deleteSheet: tool({
          description:
            'Delete one or more sheets/views from the database. This permanently removes the views and all their data. Supports batch deletion of multiple sheets. Updates both database and registry. Only use this when the user explicitly requests to delete sheet(s).',
          inputSchema: z.object({
            sheetNames: z
              .array(z.string())
              .describe(
                'Array of sheet/view names to delete. Can delete one or more sheets at once. Use listViews to see available sheets.',
              ),
          }),
          execute: async ({ sheetNames }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const dbPath = join(fileDir, 'database.db');
            const context: RegistryContext = {
              conversationDir: fileDir,
            };

            // Delete from database
            const result = await deleteSheet({
              dbPath,
              sheetNames,
            });

            for (const sheetName of result.deletedSheets) {
              await deleteViewFromRegistry(context, sheetName);
            }

            return result;
          },
        }),
        viewSheet: tool({
          description:
            'View/display the contents of a sheet. This is a convenient way to quickly see what data is in a sheet without writing a SQL query. Shows the first 50 rows by default.',
          inputSchema: z.object({
            sheetName: z
              .string()
              .describe(
                'Name of the sheet to view. You MUST specify this. If unsure, call listViews first.',
              ),
            limit: z
              .number()
              .optional()
              .describe('Maximum number of rows to display (defaults to 50)'),
          }),
          execute: async ({ sheetName, limit }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const dbPath = join(workspace, this.conversationId, 'database.db');

            const result = await viewSheet({
              dbPath,
              sheetName,
              limit,
            });
            return {
              sheetName: result.sheetName,
              totalRows: result.totalRows,
              displayedRows: result.displayedRows,
              columns: result.columns,
              rows: result.rows,
              message: result.message,
            };
          },
        }),
        getSchema: tool({
          description:
            'Get the schema of a Google Sheet view and business context. Use this to understand the data structure, entities, relationships, and vocabulary before writing queries. Business context helps translate business terms to column names and suggests JOIN conditions.',
          inputSchema: z.object({
            sheetName: z
              .string()
              .describe(
                'Name of the sheet to get schema for. You MUST specify this. If unsure, call listViews first.',
              ),
          }),
          execute: async ({ sheetName }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const dbPath = join(fileDir, 'database.db');

            const schema = await extractSchema({ dbPath, viewName: sheetName });

            // Load business context
            let businessContext = await loadBusinessContext(fileDir);
            if (!businessContext) {
              // Build fast context if not exists
              try {
                businessContext = await buildBusinessContext({
                  conversationDir: fileDir,
                  viewName: sheetName,
                  schema,
                });
                // Trigger background enhancement (fire and forget)
                try {
                  enhanceBusinessContextInBackground({
                    conversationDir: fileDir,
                    viewName: sheetName,
                    schema,
                    dbPath,
                  });
                } catch (error) {
                  console.warn(
                    '[ReadDataAgent] Background context enhancement failed',
                    {
                      conversationId: this.sanitizeForLog(this.conversationId),
                      error,
                    },
                  );
                }
              } catch (contextError) {
                console.warn(
                  '[ReadDataAgent] Failed to build business context',
                  {
                    conversationId: this.sanitizeForLog(this.conversationId),
                    error: contextError,
                  },
                );
              }
            }

            // Update view usage
            const context: RegistryContext = {
              conversationDir: fileDir,
            };
            await updateViewUsage(context, sheetName);

            return {
              schema: schema,
              businessContext: businessContext
                ? {
                    domain: businessContext.domain.domain,
                    entities: Array.from(businessContext.entities.values()).map(
                      (e) => ({
                        name: e.name,
                        columns: e.columns,
                        views: e.views,
                      }),
                    ),
                    relationships: businessContext.relationships.map((r) => ({
                      fromView: r.fromView,
                      toView: r.toView,
                      fromColumn: r.fromColumn,
                      toColumn: r.toColumn,
                      type: r.type,
                    })),
                    vocabulary: Object.fromEntries(
                      Array.from(businessContext.vocabulary.entries()).map(
                        ([key, value]) => [
                          key,
                          {
                            businessTerm: value.businessTerm,
                            technicalTerms: value.technicalTerms,
                            synonyms: value.synonyms,
                          },
                        ],
                      ),
                    ),
                  }
                : null,
            };
          },
        }),
        runQuery: tool({
          description:
            'Run a SQL query against the Google Sheet view. Business context is automatically used to improve query understanding. View usage is tracked automatically.',
          inputSchema: z.object({
            query: z.string(),
          }),
          execute: async ({ query }) => {
            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const dbPath = join(fileDir, 'database.db');

            // Load business context for query understanding
            const businessContext = await loadBusinessContext(fileDir);

            const result = await runQuery({
              dbPath,
              query,
            });

            // Extract view names from query and update usage
            const context: RegistryContext = {
              conversationDir: fileDir,
            };
            const registry = await loadViewRegistry(context);
            // Simple extraction: look for view names in FROM/JOIN clauses
            const viewNameRegex = /(?:FROM|JOIN)\s+["']?(\w+)["']?/gi;
            const matches = query.matchAll(viewNameRegex);
            const viewNames = new Set<string>();
            for (const match of matches) {
              const viewName = match[1];
              if (viewName && registry.some((r) => r.viewName === viewName)) {
                viewNames.add(viewName);
              }
            }
            // Update usage for all views used in query
            for (const viewName of viewNames) {
              await updateViewUsage(context, viewName);
            }

            return {
              result: result,
              businessContext: businessContext
                ? {
                    domain: businessContext.domain.domain,
                    entities: Array.from(businessContext.entities.values()).map(
                      (e) => ({
                        name: e.name,
                        columns: e.columns,
                      }),
                    ),
                    relationships: businessContext.relationships.map((r) => ({
                      from: r.fromView,
                      to: r.toView,
                      join: `${r.fromColumn} = ${r.toColumn}`,
                    })),
                    vocabulary: Object.fromEntries(
                      Array.from(businessContext.vocabulary.entries()).map(
                        ([key, value]) => [
                          key,
                          {
                            businessTerm: value.businessTerm,
                            technicalTerms: value.technicalTerms,
                            synonyms: value.synonyms,
                          },
                        ],
                      ),
                    ),
                  }
                : null,
            };
          },
        }),
        selectChartType: tool({
          description: `Select the best chart type (${getSupportedChartTypes().join(', ')}) for visualizing the query results. Uses business context to understand data semantics for better chart selection. This should be called before generateChart. IMPORTANT: Parameters must be at the top level: { queryResults: { columns: string[], rows: Array<Record> }, sqlQuery: string, userInput: string }`,
          inputSchema: z.object({
            queryResults: z.object({
              rows: z.array(z.record(z.unknown())).optional(),
              columns: z.array(z.string()).optional(),
              // Allow nested parameters (agent mistake - will be normalized)
              sqlQuery: z.string().optional(),
              userInput: z.string().optional(),
            }),
            // Top-level parameters (preferred format)
            sqlQuery: z.string().optional(),
            userInput: z.string().optional(),
          }),
          execute: async (input) => {
            // Normalize input: handle cases where parameters might be nested incorrectly
            let queryResults = input.queryResults;
            let sqlQuery = input.sqlQuery;
            let userInput = input.userInput;

            // Check if parameters are nested inside queryResults (common agent mistake)
            if (
              queryResults &&
              typeof queryResults === 'object' &&
              !Array.isArray(queryResults)
            ) {
              const qr = queryResults as Record<string, unknown>;

              // Extract sqlQuery if it's nested in queryResults
              if (
                !sqlQuery &&
                'sqlQuery' in qr &&
                typeof qr.sqlQuery === 'string'
              ) {
                sqlQuery = qr.sqlQuery;
              }

              // Extract userInput if it's nested in queryResults
              if (
                !userInput &&
                'userInput' in qr &&
                typeof qr.userInput === 'string'
              ) {
                userInput = qr.userInput;
              }

              // If we extracted parameters from queryResults, reconstruct queryResults
              // without those fields (they shouldn't be part of queryResults)
              if (
                (sqlQuery && 'sqlQuery' in qr) ||
                (userInput && 'userInput' in qr)
              ) {
                const { sqlQuery: _, userInput: __, ...rest } = qr;
                // Ensure we have rows and columns
                if ('rows' in rest && 'columns' in rest) {
                  queryResults = rest as {
                    rows: Record<string, unknown>[];
                    columns: string[];
                  };
                } else {
                  // If rows/columns are missing, try to extract from nested structure
                  if (
                    'queryResults' in rest &&
                    typeof rest.queryResults === 'object'
                  ) {
                    const nestedQr = rest.queryResults as Record<
                      string,
                      unknown
                    >;
                    if ('rows' in nestedQr && 'columns' in nestedQr) {
                      queryResults = {
                        rows: nestedQr.rows as Record<string, unknown>[],
                        columns: nestedQr.columns as string[],
                      };
                    }
                  }
                }
              }
            }

            // Validate required parameters
            if (!queryResults) {
              throw new Error(
                'queryResults is required. Got: ' + JSON.stringify(input),
              );
            }
            if (!queryResults.columns || !Array.isArray(queryResults.columns)) {
              throw new Error(
                'queryResults.columns must be an array. Got: ' +
                  JSON.stringify(queryResults),
              );
            }
            if (!queryResults.rows || !Array.isArray(queryResults.rows)) {
              throw new Error(
                'queryResults.rows must be an array. Got: ' +
                  JSON.stringify(queryResults),
              );
            }
            if (!sqlQuery || typeof sqlQuery !== 'string') {
              throw new Error(
                'sqlQuery is required and must be a string. Got: ' +
                  typeof sqlQuery,
              );
            }
            if (!userInput || typeof userInput !== 'string') {
              throw new Error(
                'userInput is required and must be a string. Got: ' +
                  typeof userInput,
              );
            }

            // Ensure queryResults has required fields (TypeScript type narrowing)
            const normalizedQueryResults: {
              rows: Array<Record<string, unknown>>;
              columns: string[];
            } = {
              rows: queryResults.rows,
              columns: queryResults.columns,
            };

            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const businessContext = await loadBusinessContext(fileDir);

            const selection = await selectChartType(
              normalizedQueryResults,
              sqlQuery,
              userInput,
              businessContext,
            );
            return selection;
          },
        }),
        generateChart: tool({
          description:
            'Generate chart configuration JSON for the selected chart type. Uses business context to create better labels and understand data semantics. Call selectChartType first to determine the chart type. IMPORTANT: Parameters must be at the top level: { chartType: string, queryResults: { columns: string[], rows: Array<Record> }, sqlQuery: string, userInput: string }',
          inputSchema: z.object({
            chartType: ChartTypeSchema,
            queryResults: z.object({
              rows: z.array(z.record(z.unknown())).optional(),
              columns: z.array(z.string()).optional(),
              sqlQuery: z.string().optional(),
              userInput: z.string().optional(),
            }),
            sqlQuery: z.string().optional(),
            userInput: z.string().optional(),
          }),
          execute: async (input) => {
            let chartType = input.chartType;
            let queryResults = input.queryResults;
            let sqlQuery = input.sqlQuery;
            let userInput = input.userInput;

            if (
              queryResults &&
              typeof queryResults === 'object' &&
              !Array.isArray(queryResults)
            ) {
              const qr = queryResults as Record<string, unknown>;

              if (
                !chartType &&
                'chartType' in qr &&
                typeof qr.chartType === 'string'
              ) {
                const ct = qr.chartType;
                const supportedTypes = getSupportedChartTypes();
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (supportedTypes.includes(ct as any)) {
                  chartType = ct as typeof chartType;
                }
              }

              // Extract sqlQuery if it's nested in queryResults
              if (
                !sqlQuery &&
                'sqlQuery' in qr &&
                typeof qr.sqlQuery === 'string'
              ) {
                sqlQuery = qr.sqlQuery;
              }

              // Extract userInput if it's nested in queryResults
              if (
                !userInput &&
                'userInput' in qr &&
                typeof qr.userInput === 'string'
              ) {
                userInput = qr.userInput;
              }

              // If we extracted parameters from queryResults, reconstruct queryResults
              // without those fields (they shouldn't be part of queryResults)
              if (
                (chartType && 'chartType' in qr) ||
                (sqlQuery && 'sqlQuery' in qr) ||
                (userInput && 'userInput' in qr)
              ) {
                const {
                  chartType: _,
                  sqlQuery: __,
                  userInput: ___,
                  ...rest
                } = qr;
                queryResults = rest as {
                  rows: Record<string, unknown>[];
                  columns: string[];
                };
              }
            }

            // Validate required parameters
            const supportedTypes = getSupportedChartTypes();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if (!chartType || !supportedTypes.includes(chartType as any)) {
              throw new Error(
                `chartType is required and must be one of: ${supportedTypes.join(', ')}. Got: ${chartType}`,
              );
            }
            if (!queryResults) {
              throw new Error(
                'queryResults is required. Got: ' + JSON.stringify(input),
              );
            }
            if (!queryResults.columns || !Array.isArray(queryResults.columns)) {
              throw new Error(
                'queryResults.columns must be an array. Got: ' +
                  JSON.stringify(queryResults),
              );
            }
            if (!queryResults.rows || !Array.isArray(queryResults.rows)) {
              throw new Error(
                'queryResults.rows must be an array. Got: ' +
                  JSON.stringify(queryResults),
              );
            }
            if (!sqlQuery || typeof sqlQuery !== 'string') {
              throw new Error(
                'sqlQuery is required and must be a string. Got: ' +
                  typeof sqlQuery,
              );
            }
            if (!userInput || typeof userInput !== 'string') {
              throw new Error(
                'userInput is required and must be a string. Got: ' +
                  typeof userInput,
              );
            }

            // Ensure queryResults has required fields (TypeScript type narrowing)
            const normalizedQueryResults: {
              rows: Array<Record<string, unknown>>;
              columns: string[];
            } = {
              rows: queryResults.rows,
              columns: queryResults.columns,
            };

            const workspace = getWorkspace();
            if (!workspace) {
              throw new Error('WORKSPACE environment variable is not set');
            }
            const { join } = await import('node:path');
            const fileDir = join(workspace, this.conversationId);
            const businessContext = await loadBusinessContext(fileDir);

            const chartConfig = await generateChart({
              queryResults: normalizedQueryResults,
              sqlQuery,
              userInput,
              chartType, // Pass the pre-selected chart type
              businessContext,
            });
            return chartConfig;
          },
        }),
      },
      stopWhen: stepCountIs(20), // Stop after 20 steps maximum
    });
  }
}

function isLanguageModel(model: unknown): model is LanguageModel {
  return typeof model === 'object' && model !== null;
}
