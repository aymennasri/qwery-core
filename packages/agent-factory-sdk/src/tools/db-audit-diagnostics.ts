import { z } from 'zod';

import { DetectDbEngineTool } from './detect-db-engine';
import { GetBloatEstimatesTool } from './get-bloat-estimates';
import { GetIndexHealthTool } from './get-index-health';
import { GetInfraRuntimeSignalsTool } from './get-infra-runtime-signals';
import { GetLockAndBlockingAnalysisTool } from './get-lock-and-blocking-analysis';
import { GetRecentDbLogsTool } from './get-recent-db-logs';
import { GetReplicationHealthTool } from './get-replication-health';
import { GetStatisticsHealthTool } from './get-statistics-health';
import { GetTableHealthTool } from './get-table-health';
import { GetTopSlowQueriesTool } from './get-top-slow-queries';
import { Tool, type ToolContext, type ToolInfo } from './tool';

const DESCRIPTION =
  'Collect compact read-only PostgreSQL audit diagnostics through one bounded interface. Returns top findings and summaries, not raw full diagnostic payloads.';

const checkSchema = z.enum([
  'engine',
  'runtime',
  'logs',
  'statistics',
  'locks',
  'bloat',
  'replication',
  'indexes',
  'tables',
  'slow_queries',
]);

type Check = z.infer<typeof checkSchema>;
type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null
    ? (value as JsonObject)
    : {};
}

function asArray(value: unknown): JsonObject[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is JsonObject => typeof item === 'object' && item !== null,
      )
    : [];
}

function pick(source: JsonObject, keys: string[]): JsonObject {
  const result: JsonObject = {};
  for (const key of keys) {
    if (source[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function topBy(
  rows: JsonObject[],
  key: string,
  limit: number,
  fields: string[],
): JsonObject[] {
  return rows
    .toSorted((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0))
    .slice(0, limit)
    .map((row) => pick(row, fields));
}

function compactRuntimeSummary(runtime: JsonObject): JsonObject {
  return {
    database: runtime.database,
    capturedAt: runtime.capturedAt,
    postgresVersion: runtime.postgresVersion,
    uptimeSeconds: asObject(runtime.os).uptimeSeconds,
    connection: pick(asObject(runtime.connection), [
      'maxConnections',
      'totalSessions',
      'activeSessions',
      'idleSessions',
      'waitingActiveSessions',
      'utilizationPct',
    ]),
    waits: pick(asObject(runtime.waits), [
      'lockWaitSessions',
      'ioWaitSessions',
      'networkWaitSessions',
      'activeWaitEventTypes',
      'activeWaitEvents',
    ]),
    io: runtime.io,
    checkpoints: runtime.checkpoints,
    config: runtime.config,
    logging: runtime.logging,
    sourceNotes: runtime.sourceNotes,
  };
}

async function runTool(
  tool: ToolInfo,
  params: JsonObject,
  ctx: ToolContext,
): Promise<JsonObject> {
  if (!('execute' in tool)) {
    throw new Error(`${tool.id} cannot be used by db_audit_diagnostics.`);
  }
  return asObject(await tool.execute(params, ctx));
}

export const DbAuditDiagnosticsTool = Tool.define('db_audit_diagnostics', {
  description: DESCRIPTION,
  parameters: z.object({
    checks: z.array(checkSchema).min(1),
    limits: z
      .object({
        topTables: z.number().int().positive().max(20).optional(),
        topIndexes: z.number().int().positive().max(20).optional(),
        topQueries: z.number().int().positive().max(20).optional(),
        topEvents: z.number().int().positive().max(20).optional(),
      })
      .optional(),
  }),
  async execute(params, ctx) {
    const checks = new Set<Check>(params.checks);
    const topTables = params.limits?.topTables ?? 5;
    const topIndexes = params.limits?.topIndexes ?? 5;
    const topQueries = params.limits?.topQueries ?? 5;
    const topEvents = params.limits?.topEvents ?? 5;
    const result: JsonObject = {
      requestedChecks: params.checks,
      blockedChecks: [],
      artifacts: {},
    };

    if (checks.has('engine')) {
      const engine = await runTool(DetectDbEngineTool, {}, ctx);
      result.engine = pick(engine, [
        'engine',
        'provider',
        'datasourceId',
        'version',
        'database',
        'schema',
        'capabilities',
      ]);
    }

    if (checks.has('runtime')) {
      const runtime = await runTool(GetInfraRuntimeSignalsTool, {}, ctx);
      result.runtimeSummary = compactRuntimeSummary(runtime);
    }

    if (checks.has('logs')) {
      const logs = await runTool(
        GetRecentDbLogsTool,
        { limit: topEvents },
        ctx,
      );
      result.logSignals = pick(logs, [
        'available',
        'source',
        'events',
        'summary',
        'sourceNotes',
      ]);
    }

    if (checks.has('statistics')) {
      const statistics = await runTool(
        GetStatisticsHealthTool,
        { limit: Math.max(topTables, topEvents) },
        ctx,
      );
      result.statisticsFindings = {
        staleTables: asArray(statistics.staleTables)
          .slice(0, topTables)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'liveTuples',
              'modSinceAnalyze',
              'modRatioPct',
              'mostRecentAnalyze',
              'secondsSinceAnalyze',
            ]),
          ),
        neverAnalyzedTables: asArray(statistics.neverAnalyzedTables)
          .slice(0, topTables)
          .map((row) =>
            pick(row, ['schema', 'table', 'liveTuples', 'seqScan', 'idxScan']),
          ),
        suspectColumns: asArray(statistics.suspectColumns)
          .slice(0, topEvents)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'column',
              'nDistinct',
              'correlation',
              'liveTuples',
            ]),
          ),
        pgStatStatements: statistics.pgStatStatements,
        sourceNotes: statistics.sourceNotes,
      };
    }

    if (checks.has('locks')) {
      const locks = await runTool(GetLockAndBlockingAnalysisTool, {}, ctx);
      result.lockSummary = pick(locks, [
        'lockWaitSessions',
        'blockingChains',
        'idleInTransactionSessions',
        'deadlocks',
        'sourceNotes',
      ]);
    }

    if (checks.has('bloat')) {
      const bloat = await runTool(
        GetBloatEstimatesTool,
        { limit: topTables },
        ctx,
      );
      result.bloatFindings = {
        dbSummary: bloat.dbSummary,
        tableBloat: asArray(bloat.tableBloat)
          .slice(0, topTables)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'heapBytes',
              'totalBytes',
              'estimatedDeadTupleBytes',
              'deadTupleBloatPct',
              'lastVacuum',
              'lastAutovacuum',
            ]),
          ),
        indexBloatCandidates: asArray(bloat.indexBloatCandidates)
          .slice(0, topIndexes)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'index',
              'indexBytes',
              'idxScan',
              'isPrimary',
              'isUnique',
              'backsConstraint',
            ]),
          ),
        topTablesBySize: asArray(bloat.topTablesBySize)
          .slice(0, topTables)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'totalBytes',
              'heapBytes',
              'indexBytes',
            ]),
          ),
        sourceNotes: bloat.sourceNotes,
      };
    }

    if (checks.has('replication')) {
      const replication = await runTool(GetReplicationHealthTool, {}, ctx);
      result.replicationSummary = replication;
    }

    if (checks.has('indexes')) {
      const indexes = await runTool(
        GetIndexHealthTool,
        { limit: topIndexes },
        ctx,
      );
      result.topIndexFindings = {
        highSeqScanTables: asArray(indexes.highSeqScanTables)
          .slice(0, topTables)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'seqScan',
              'idxScan',
              'liveTuples',
              'estimatedSeqRowsRead',
              'seqScanRatio',
            ]),
          ),
        unusedIndexes: topBy(
          asArray(indexes.unusedIndexes),
          'sizeBytes',
          topIndexes,
          [
            'schema',
            'table',
            'index',
            'scans',
            'sizeBytes',
            'isUnique',
            'isPrimary',
            'backsConstraint',
            'dropCandidate',
          ],
        ),
        duplicateIndexes: asArray(indexes.duplicateIndexes)
          .slice(0, topIndexes)
          .map((row) =>
            pick(row, [
              'schema',
              'table',
              'indexSignature',
              'indexNames',
              'duplicateCount',
            ]),
          ),
      };
    }

    if (checks.has('tables')) {
      const tables = await runTool(
        GetTableHealthTool,
        { limit: topTables },
        ctx,
      );
      result.topTableFindings = asArray(tables.tables).map((row) =>
        pick(row, [
          'schema',
          'table',
          'liveTuples',
          'deadTuples',
          'deadTuplePct',
          'modSinceAnalyze',
          'modSinceAnalyzePct',
          'totalSizeBytes',
          'seqScan',
          'idxScan',
          'seqTupRead',
          'mostRecentVacuum',
          'mostRecentAnalyze',
          'autovacuumEnabledOverride',
        ]),
      );
    }

    if (checks.has('slow_queries')) {
      const slowQueries = await runTool(
        GetTopSlowQueriesTool,
        { limit: topQueries },
        ctx,
      );
      result.slowQueryFindings = pick(slowQueries, [
        'source',
        'queries',
        'sourceNotes',
      ]);
    }

    return result;
  },
});
