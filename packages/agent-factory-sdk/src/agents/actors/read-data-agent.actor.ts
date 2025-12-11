import { z } from 'zod';
import {
  Experimental_Agent as Agent,
  convertToModelMessages,
  UIMessage,
  tool,
  validateUIMessages,
  stepCountIs,
} from 'ai';
import { fromPromise } from 'xstate/actors';
import { resolveModel } from '../../services';
import { testConnection } from '../../tools/test-connection';
import type { SimpleSchema, SimpleTable } from '@qwery/domain/entities';
import { runQuery } from '../../tools/run-query';
import { listAvailableSheets } from '../../tools/list-available-sheets';
import { viewSheet } from '../../tools/view-sheet';
import { renameSheet } from '../../tools/rename-sheet';
import { deleteSheet } from '../../tools/delete-sheet';
import { selectChartType, generateChart } from '../tools/generate-chart';
import { loadBusinessContext } from '../../tools/utils/business-context.storage';
import { READ_DATA_AGENT_PROMPT } from '../prompts/read-data-agent.prompt';
import type { BusinessContext } from '../../tools/types/business-context.types';
import { mergeBusinessContexts } from '../../tools/utils/business-context.storage';
import { getConfig } from '../../tools/utils/business-context.config';
import { buildBusinessContext } from '../../tools/build-business-context';
import { enhanceBusinessContextInBackground } from './enhance-business-context.actor';
import type { Repositories } from '@qwery/domain/repositories';
import { initializeDatasources } from '../../tools/datasource-initializer';
import { GetConversationBySlugService } from '@qwery/domain/services';
import { DuckDBInstanceManager } from '../../tools/duckdb-instance-manager';

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

export const readDataAgent = async (
  conversationId: string,
  messages: UIMessage[],
  model: string,
  repositories?: Repositories,
) => {
  // Initialize datasources if repositories are provided
  if (repositories) {
    const workspace = getWorkspace();
    if (workspace) {
      try {
        // Get conversation to find datasources
        // Note: conversationId is actually a slug in this context
        const getConversationService = new GetConversationBySlugService(
          repositories.conversation,
        );
        const conversation =
          await getConversationService.execute(conversationId);

        if (conversation?.datasources && conversation.datasources.length > 0) {
          // Initialize all datasources with checked state
          const initResults = await initializeDatasources({
            conversationId,
            datasourceIds: conversation.datasources,
            datasourceRepository: repositories.datasource,
            workspace,
            checkedDatasourceIds: conversation.datasources, // All are checked initially
          });

          // Log initialization results for debugging
          const successful = initResults.filter((r) => r.success);
          const failed = initResults.filter((r) => !r.success);

          if (successful.length > 0) {
            console.log(
              `[ReadDataAgent] Initialized ${successful.length} datasource(s) with ${successful.reduce((sum, r) => sum + r.viewsCreated, 0)} view(s)`,
            );
          }

          if (failed.length > 0) {
            console.warn(
              `[ReadDataAgent] Failed to initialize ${failed.length} datasource(s):`,
              failed.map((f) => `${f.datasourceName} (${f.error})`).join(', '),
            );
          }
        } else {
          console.log(
            `[ReadDataAgent] No datasources found in conversation ${conversationId}`,
          );
        }
      } catch (error) {
        // Log but don't fail - datasources might not be available yet
        console.warn(
          `[ReadDataAgent] Failed to initialize datasources:`,
          error,
        );
      }
    }
  }

  const result = new Agent({
    model: await resolveModel(model),
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
          const dbPath = join(workspace, conversationId, 'database.db');
          // testConnection still uses dbPath directly, which is fine for testing
          const result = await testConnection({
            dbPath: dbPath,
          });
          return result.toString();
        },
      }),
      getSchema: tool({
        description:
          'Discover available data structures directly from DuckDB (views + attached databases). If viewName is provided, returns schema for that specific view/table (accepts fully qualified paths). If not provided, returns schemas for everything discovered in DuckDB. This updates the business context automatically.',
        inputSchema: z.object({
          viewName: z.string().optional(),
        }),
        execute: async ({ viewName }) => {
          console.log(
            `[ReadDataAgent] getSchema called${viewName ? ` for view: ${viewName}` : ' (all views)'}`,
          );

          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);
          const dbPath = join(fileDir, 'database.db');

          console.log(
            `[ReadDataAgent] Workspace: ${workspace}, ConversationId: ${conversationId}, dbPath: ${dbPath}`,
          );

          // Get connection from manager
          const conn = await DuckDBInstanceManager.getConnection(
            conversationId,
            workspace,
          );

          // Sync datasources before querying schema
          if (repositories) {
            try {
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              if (conversation?.datasources?.length) {
                await DuckDBInstanceManager.syncDatasources(
                  conversationId,
                  workspace,
                  conversation.datasources,
                  repositories.datasource,
                );
              }
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to sync datasources:',
                error,
              );
            }
          }

          // Helper to describe a single table/view
          const describeObject = async (
            db: string,
            schemaName: string,
            tableName: string,
          ): Promise<SimpleSchema | null> => {
            try {
              const escapedDb = db.replace(/"/g, '""');
              const escapedSchema = schemaName.replace(/"/g, '""');
              const escapedTable = tableName.replace(/"/g, '""');
              const describeQuery = `DESCRIBE "${escapedDb}"."${escapedSchema}"."${escapedTable}"`;
              const reader = await conn.runAndReadAll(describeQuery);
              await reader.readAll();
              const rows = reader.getRowObjectsJS() as Array<{
                column_name: string;
                column_type: string;
              }>;
              return {
                databaseName: db,
                schemaName,
                tables: [
                  {
                    tableName,
                    columns: rows.map((row) => ({
                      columnName: row.column_name,
                      columnType: row.column_type,
                    })),
                  },
                ],
              };
            } catch {
              return null;
            }
          };

          const collectedSchemas: Map<string, SimpleSchema> = new Map();

          try {
            const dbReader = await conn.runAndReadAll(
              'SELECT name FROM pragma_database_list;',
            );
            await dbReader.readAll();
            const dbRows = dbReader.getRowObjectsJS() as Array<{
              name: string;
            }>;
            const databases = dbRows.map((r) => r.name);

            const targets: Array<{
              db: string;
              schema: string;
              table: string;
            }> = [];

            // Get system schemas using extension abstraction
            const { getAllSystemSchemas, isSystemTableName } = await import(
              '../../tools/system-schema-filter'
            );
            const systemSchemas = getAllSystemSchemas();

            for (const db of databases) {
              const escapedDb = db.replace(/"/g, '""');

              // For attached foreign databases, query their information_schema directly
              // For main database, query the default information_schema
              const isAttachedDb = db.startsWith('ds_');

              let tableRows: Array<{
                table_schema: string;
                table_name: string;
                table_type: string;
              }> = [];
              let viewRows: Array<{
                table_schema: string;
                table_name: string;
                table_type: string;
              }> = [];

              if (isAttachedDb) {
                // For attached databases, query their information_schema directly
                try {
                  // Include both tables AND views in single query
                  const tablesReader = await conn.runAndReadAll(`
                    SELECT table_schema, table_name, table_type
                    FROM "${escapedDb}".information_schema.tables
                    WHERE table_type IN ('BASE TABLE', 'VIEW')
                  `);
                  await tablesReader.readAll();
                  tableRows = tablesReader.getRowObjectsJS() as Array<{
                    table_schema: string;
                    table_name: string;
                    table_type: string;
                  }>;
                  // No separate views query needed - already included above
                  viewRows = [];
                } catch (error) {
                  console.warn(
                    `[ReadDataAgent] Failed to query tables from attached database ${db}: ${error}`,
                  );
                  continue;
                }
              } else {
                // For main database, query the default information_schema
                try {
                  // Include both tables AND views in single query
                  const tablesReader = await conn.runAndReadAll(`
                    SELECT table_schema, table_name, table_type
                    FROM information_schema.tables
                    WHERE table_catalog = '${escapedDb}'
                      AND table_type IN ('BASE TABLE', 'VIEW')
                  `);
                  await tablesReader.readAll();
                  tableRows = tablesReader.getRowObjectsJS() as Array<{
                    table_schema: string;
                    table_name: string;
                    table_type: string;
                  }>;
                  // No separate views query needed - already included above
                  viewRows = [];
                } catch (error) {
                  console.warn(
                    `[ReadDataAgent] Failed to query tables from database ${db}: ${error}`,
                  );
                  continue;
                }
              }

              // Combine tables and views
              const allRows = [...tableRows, ...viewRows];

              let skippedSystemSchemas = 0;
              let skippedSystemTables = 0;

              for (const row of allRows) {
                const schemaName = (row.table_schema || 'main').toLowerCase();

                // Skip system schemas (NO LOGGING - just count)
                if (systemSchemas.has(schemaName)) {
                  skippedSystemSchemas++;
                  continue;
                }

                // Skip system tables (NO LOGGING - just count)
                if (isSystemTableName(row.table_name)) {
                  skippedSystemTables++;
                  continue;
                }

                targets.push({
                  db,
                  schema: row.table_schema || 'main',
                  table: row.table_name,
                });
              }

              // Log summary only if there were skips
              if (skippedSystemSchemas > 0 || skippedSystemTables > 0) {
                console.debug(
                  `[ReadDataAgent] Filtered ${skippedSystemSchemas} system schemas and ${skippedSystemTables} system tables from ${db}`,
                );
              }
            }

            if (viewName) {
              // Describe only the requested object
              const viewId = viewName as string;
              let db = 'main';
              let schemaName = 'main';
              let tableName = viewId;
              if (viewId.includes('.')) {
                const parts = viewId.split('.').filter(Boolean);
                if (parts.length === 3) {
                  db = parts[0] ?? db;
                  schemaName = parts[1] ?? schemaName;
                  tableName = parts[2] ?? tableName;
                } else if (parts.length === 2) {
                  schemaName = parts[0] ?? schemaName;
                  tableName = parts[1] ?? tableName;
                } else if (parts.length === 1) {
                  tableName = parts[0] ?? tableName;
                }
              }
              // Check if this is a system table before describing
              const { isSystemOrTempTable } = await import(
                '../../tools/utils/business-context.utils'
              );
              const fullName = `${db}.${schemaName}.${tableName}`;

              if (isSystemOrTempTable(fullName)) {
                throw new Error(
                  `Cannot access system table: ${viewId}. Please query user tables only.`,
                );
              }

              const schema = await describeObject(db, schemaName, tableName);
              if (!schema) {
                throw new Error(`Object "${viewId}" not found in DuckDB`);
              }
              collectedSchemas.set(viewId, schema);
            } else {
              // Describe everything discovered
              for (const target of targets) {
                const fullName = `${target.db}.${target.schema}.${target.table}`;
                const schema = await describeObject(
                  target.db,
                  target.schema,
                  target.table,
                );
                if (schema) {
                  collectedSchemas.set(fullName, schema);
                }
              }
            }
          } finally {
            // Return connection to pool
            DuckDBInstanceManager.returnConnection(
              conversationId,
              workspace,
              conn,
            );
          }

          // Get performance configuration
          const perfConfig = await getConfig(fileDir);

          // Build schemasMap with all collected schemas
          const schemasMap = collectedSchemas;

          // If viewName specified, return that specific schema
          // Otherwise, return ALL schemas combined
          let schema: SimpleSchema;
          if (viewName && collectedSchemas.has(viewName)) {
            // Single view requested
            schema = collectedSchemas.get(viewName)!;
          } else {
            // All views - combine all schemas into one
            const allTables: SimpleTable[] = [];
            for (const [schemaName, schemaData] of collectedSchemas.entries()) {
              // Add tables from each schema
              for (const table of schemaData.tables) {
                allTables.push({
                  ...table,
                  // Optionally prefix table name with schema identifier for clarity
                  tableName: schemaName.includes('.')
                    ? table.tableName // Already qualified
                    : table.tableName,
                });
              }
            }

            // Determine primary database/schema from first entry or use defaults
            const firstSchema = collectedSchemas.values().next().value;
            schema = {
              databaseName: firstSchema?.databaseName || 'main',
              schemaName: firstSchema?.schemaName || 'main',
              tables: allTables,
            };
          }

          // Build fast context (synchronous, < 100ms)
          let fastContext: BusinessContext;
          if (viewName) {
            // Single view - build fast context
            fastContext = await buildBusinessContext({
              conversationDir: fileDir,
              viewName,
              schema,
            });

            // Start enhancement in background (don't await)
            enhanceBusinessContextInBackground({
              conversationDir: fileDir,
              viewName,
              schema,
              dbPath,
            });
          } else {
            // Multiple views - build fast context for each
            // Filter out system tables before processing
            const { isSystemOrTempTable } = await import(
              '../../tools/utils/business-context.utils'
            );

            const fastContexts: BusinessContext[] = [];
            for (const [vName, vSchema] of schemasMap.entries()) {
              // Skip system tables
              if (isSystemOrTempTable(vName)) {
                console.debug(
                  `[ReadDataAgent] Skipping system table in context building: ${vName}`,
                );
                continue;
              }

              // Also check if schema has any valid tables
              const hasValidTables = vSchema.tables.some(
                (t) => !isSystemOrTempTable(t.tableName),
              );
              if (!hasValidTables) {
                console.debug(
                  `[ReadDataAgent] Skipping schema with no valid tables: ${vName}`,
                );
                continue;
              }

              const ctx = await buildBusinessContext({
                conversationDir: fileDir,
                viewName: vName,
                schema: vSchema,
              });
              fastContexts.push(ctx);

              // Start enhancement in background for each view
              enhanceBusinessContextInBackground({
                conversationDir: fileDir,
                viewName: vName,
                schema: vSchema,
                dbPath,
              });
            }
            // Merge all fast contexts into one
            fastContext = mergeBusinessContexts(fastContexts);
          }

          // Use fast context for immediate response
          const entities = Array.from(fastContext.entities.values()).slice(
            0,
            perfConfig.expectedViewCount * 2,
          );
          const relationships = fastContext.relationships.slice(
            0,
            perfConfig.expectedViewCount * 3,
          );
          const vocabulary = Object.fromEntries(
            Array.from(fastContext.vocabulary.entries())
              .slice(0, perfConfig.expectedViewCount * 10)
              .map(([key, entry]) => [key, entry]),
          );

          // Include information about all discovered tables in the response
          const allTableNames = Array.from(collectedSchemas.keys());
          const tableCount = allTableNames.length;

          // Return schema and data insights (hide technical jargon)
          return {
            schema: schema,
            allTables: allTableNames, // Add this - list of all table/view names
            tableCount: tableCount, // Add this - total count
            businessContext: {
              domain: fastContext.domain.domain, // Just the domain name string
              entities: entities.map((e) => ({
                name: e.name,
                columns: e.columns,
              })), // Simplified - just name and columns
              relationships: relationships.map((r) => ({
                from: r.fromView,
                to: r.toView,
                join: r.joinCondition,
              })), // Simplified - just connection info
              vocabulary: vocabulary, // Keep for internal use but don't expose structure
            },
          };
        },
      }),
      runQuery: tool({
        description:
          'Run a SQL query against the DuckDB instance (views from file-based datasources or attached database tables). Query views by name (e.g., "customers") or attached tables by full path (e.g., ds_x.public.users). DuckDB enables federated queries across PostgreSQL, MySQL, Google Sheets, and other datasources.',
        inputSchema: z.object({
          query: z.string(),
        }),
        execute: async ({ query }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }

          // Sync datasources before querying if repositories available
          if (repositories) {
            try {
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              if (conversation?.datasources?.length) {
                await DuckDBInstanceManager.syncDatasources(
                  conversationId,
                  workspace,
                  conversation.datasources,
                  repositories.datasource,
                );
              }
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to sync datasources before query:',
                error,
              );
            }
          }

          const result = await runQuery({
            conversationId,
            workspace,
            query,
          });

          return {
            result: result,
          };
        },
      }),
      listAvailableSheets: tool({
        description:
          'List all available sheets/views in the database. Returns a list of sheet names and their types (view or table).',
        inputSchema: z.object({}),
        execute: async () => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          if (!repositories?.datasource) {
            throw new Error('Datasource repository not available');
          }

          // Sync datasources before listing (same as getSchema and runQuery)
          if (repositories) {
            try {
              const getConversationService = new GetConversationBySlugService(
                repositories.conversation,
              );
              const conversation =
                await getConversationService.execute(conversationId);
              if (conversation?.datasources?.length) {
                await DuckDBInstanceManager.syncDatasources(
                  conversationId,
                  workspace,
                  conversation.datasources,
                  repositories.datasource,
                );
              }
            } catch (error) {
              console.warn(
                '[ReadDataAgent] Failed to sync datasources before listing:',
                error,
              );
            }
          }

          const result = await listAvailableSheets({
            conversationId,
            workspace,
            datasourceRepository: repositories.datasource,
          });
          return result;
        },
      }),
      renameSheet: tool({
        description:
          'Rename a sheet/view to give it a more meaningful name. Both oldSheetName and newSheetName are required.',
        inputSchema: z.object({
          oldSheetName: z.string(),
          newSheetName: z.string(),
        }),
        execute: async ({ oldSheetName, newSheetName }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const result = await renameSheet({
            conversationId,
            workspace,
            oldSheetName,
            newSheetName,
          });
          return result;
        },
      }),
      deleteSheet: tool({
        description:
          'Delete one or more sheets/views from the database. Takes an array of sheet names to delete.',
        inputSchema: z.object({
          sheetNames: z.array(z.string()),
        }),
        execute: async ({ sheetNames }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const result = await deleteSheet({
            conversationId,
            workspace,
            sheetNames,
          });
          return result;
        },
      }),
      viewSheet: tool({
        description:
          'View the contents of a sheet (first N rows). Shows the sheet data in a table format. Optionally specify a limit (default 50 rows).',
        inputSchema: z.object({
          sheetName: z.string(),
          limit: z.number().optional(),
        }),
        execute: async ({ sheetName, limit }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const result = await viewSheet({
            conversationId,
            workspace,
            sheetName,
            limit,
          });
          return result;
        },
      }),
      selectChartType: tool({
        description:
          'Analyzes query results to determine the best chart type (bar, line, or pie) based on the data structure and user intent. Use this before generating a chart to select the most appropriate visualization type.',
        inputSchema: z.object({
          queryResults: z.object({
            rows: z.array(z.record(z.unknown())),
            columns: z.array(z.string()),
          }),
          sqlQuery: z.string().optional(),
          userInput: z.string().optional(),
        }),
        execute: async ({ queryResults, sqlQuery = '', userInput = '' }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);

          // Load business context if available
          let businessContext: BusinessContext | null = null;
          try {
            businessContext = await loadBusinessContext(fileDir);
          } catch {
            // Business context not available, continue without it
          }

          const result = await selectChartType(
            queryResults,
            sqlQuery,
            userInput,
            businessContext,
          );
          return result;
        },
      }),
      generateChart: tool({
        description:
          'Generates a chart configuration JSON for visualization. Takes query results and creates a chart (bar, line, or pie) with proper data transformation, colors, and labels. Use this after selecting a chart type or when the user requests a specific chart type.',
        inputSchema: z.object({
          chartType: z.enum(['bar', 'line', 'pie']).optional(),
          queryResults: z.object({
            rows: z.array(z.record(z.unknown())),
            columns: z.array(z.string()),
          }),
          sqlQuery: z.string().optional(),
          userInput: z.string().optional(),
        }),
        execute: async ({
          chartType,
          queryResults,
          sqlQuery = '',
          userInput = '',
        }) => {
          const workspace = getWorkspace();
          if (!workspace) {
            throw new Error('WORKSPACE environment variable is not set');
          }
          const { join } = await import('node:path');
          const fileDir = join(workspace, conversationId);

          // Load business context if available
          let businessContext: BusinessContext | null = null;
          try {
            businessContext = await loadBusinessContext(fileDir);
          } catch {
            // Business context not available, continue without it
          }

          const result = await generateChart({
            chartType,
            queryResults,
            sqlQuery,
            userInput,
            businessContext,
          });
          return result;
        },
      }),
    },
    stopWhen: stepCountIs(20),
  });

  return result.stream({
    messages: convertToModelMessages(await validateUIMessages({ messages })),
    providerOptions: {
      openai: {
        reasoningSummary: 'auto', // 'auto' for condensed or 'detailed' for comprehensive
        reasoningEffort: 'medium',
        reasoningDetailedSummary: true,
        reasoningDetailedSummaryLength: 'long',
      },
    },
  });
};

export const readDataAgentActor = fromPromise(
  async ({
    input,
  }: {
    input: {
      conversationId: string;
      previousMessages: UIMessage[];
      model: string;
      repositories?: Repositories;
    };
  }) => {
    return readDataAgent(
      input.conversationId,
      input.previousMessages,
      input.model,
      input.repositories,
    );
  },
);
