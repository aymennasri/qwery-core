import { z } from 'zod';
import { Tool } from './tool';
import {
  getErrorMessage,
  isPostgresDatasource,
  toNumber,
  toSafeLimit,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';

const DESCRIPTION =
  'Analyze PostgreSQL lock contention: blocking chains via pg_blocking_pids(), idle-in-transaction sessions, lock type distribution, long-running active queries, and cumulative deadlock count.';

export const GetLockAndBlockingAnalysisTool = Tool.define(
  'get_lock_and_blocking_analysis',
  {
    description: DESCRIPTION,
    parameters: z.object({
      limit: z
        .number()
        .int()
        .positive()
        .max(50)
        .optional()
        .describe('Maximum rows per result section (default: 20).'),
      longRunningThresholdSeconds: z
        .number()
        .int()
        .positive()
        .max(3600)
        .optional()
        .describe(
          'Minimum seconds a query must be running to appear in long-running results (default: 5).',
        ),
    }),
    async execute(params, ctx) {
      const limit = toSafeLimit(params.limit, 20, 50);
      const longRunningThreshold = toSafeLimit(
        params.longRunningThresholdSeconds,
        5,
        3600,
      );

      return withDatasourceDriver(ctx, async ({ datasource, query }) => {
        if (!isPostgresDatasource(datasource)) {
          throw new Error(
            `This tool currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
          );
        }

        const sourceNotes: string[] = [];

        const queryRowsOrEmpty = async (
          sql: string,
          label: string,
        ): Promise<Array<Record<string, unknown>>> => {
          try {
            const result = await query(sql);
            return result.rows;
          } catch (error) {
            sourceNotes.push(`${label} (${getErrorMessage(error)}).`);
            return [];
          }
        };

        const queryOneOrEmpty = async (
          sql: string,
          label: string,
        ): Promise<Record<string, unknown>> => {
          const rows = await queryRowsOrEmpty(sql, label);
          return rows[0] ?? {};
        };

        // ------------------------------------------------------------------
        // 1. Blocking chains via pg_blocking_pids()
        // ------------------------------------------------------------------
        const blockingChainRows = await queryRowsOrEmpty(
          `
          SELECT
            blocked.pid                                                             AS blocked_pid,
            blocked.usename                                                         AS blocked_user,
            blocked.application_name                                                AS blocked_app,
            blocked.state                                                           AS blocked_state,
            EXTRACT(EPOCH FROM (clock_timestamp() - blocked.state_change))
              ::double precision                                                    AS blocked_duration_seconds,
            LEFT(regexp_replace(blocked.query, '\\s+', ' ', 'g'), 2000)            AS blocked_query,
            blocker.pid                                                             AS blocker_pid,
            blocker.usename                                                         AS blocker_user,
            blocker.application_name                                                AS blocker_app,
            blocker.state                                                           AS blocker_state,
            EXTRACT(EPOCH FROM (clock_timestamp() - blocker.state_change))
              ::double precision                                                    AS blocker_duration_seconds,
            LEFT(regexp_replace(blocker.query, '\\s+', ' ', 'g'), 2000)            AS blocker_query
          FROM pg_stat_activity  blocked
          JOIN pg_stat_activity  blocker
            ON blocker.pid = ANY(pg_blocking_pids(blocked.pid))
          WHERE blocked.pid <> pg_backend_pid()
            AND cardinality(pg_blocking_pids(blocked.pid)) > 0
          ORDER BY blocked_duration_seconds DESC NULLS LAST
          LIMIT ${limit}
        `,
          'Unable to collect blocking chains from pg_stat_activity + pg_blocking_pids',
        );

        // ------------------------------------------------------------------
        // 2. Idle-in-transaction sessions
        // ------------------------------------------------------------------
        const idleInTransactionRows = await queryRowsOrEmpty(
          `
          SELECT
            pid,
            usename                                                                 AS user_name,
            application_name,
            state,
            EXTRACT(EPOCH FROM (clock_timestamp() - state_change))
              ::double precision                                                    AS idle_in_transaction_seconds,
            LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 1000)                    AS last_query,
            wait_event_type,
            wait_event
          FROM pg_stat_activity
          WHERE state IN ('idle in transaction', 'idle in transaction (aborted)')
            AND pid <> pg_backend_pid()
          ORDER BY idle_in_transaction_seconds DESC NULLS LAST
          LIMIT ${limit}
        `,
          'Unable to collect idle-in-transaction sessions from pg_stat_activity',
        );

        // ------------------------------------------------------------------
        // 3. Lock type distribution from pg_locks
        // ------------------------------------------------------------------
        const lockTypeRows = await queryRowsOrEmpty(
          `
          SELECT
            locktype,
            mode,
            granted,
            COUNT(*)::bigint AS lock_count
          FROM pg_locks
          WHERE pid <> pg_backend_pid()
          GROUP BY locktype, mode, granted
          ORDER BY lock_count DESC
          LIMIT ${limit}
        `,
          'Unable to collect lock type distribution from pg_locks',
        );

        // ------------------------------------------------------------------
        // 4. Long-running active queries (not idle-in-transaction)
        // ------------------------------------------------------------------
        const longRunningRows = await queryRowsOrEmpty(
          `
          SELECT
            pid,
            usename                                                                 AS user_name,
            application_name,
            state,
            EXTRACT(EPOCH FROM (clock_timestamp() - query_start))
              ::double precision                                                    AS query_duration_seconds,
            wait_event_type,
            wait_event,
            LEFT(regexp_replace(query, '\\s+', ' ', 'g'), 1000)                    AS query
          FROM pg_stat_activity
          WHERE state = 'active'
            AND query_start IS NOT NULL
            AND pid <> pg_backend_pid()
            AND EXTRACT(EPOCH FROM (clock_timestamp() - query_start)) > ${longRunningThreshold}
            AND query NOT ILIKE '%pg_stat_activity%'
            AND query NOT ILIKE '%pg_stat_%'
            AND query NOT ILIKE '%pg_catalog.%'
            AND query NOT ILIKE '%information_schema.%'
          ORDER BY query_duration_seconds DESC NULLS LAST
          LIMIT ${limit}
        `,
          'Unable to collect long-running active queries from pg_stat_activity',
        );

        // ------------------------------------------------------------------
        // 5. Cumulative deadlock and conflict counters
        // ------------------------------------------------------------------
        const deadlockRow = await queryOneOrEmpty(
          `
          SELECT
            deadlocks,
            conflicts
          FROM pg_stat_database
          WHERE datname = current_database()
        `,
          'Unable to collect deadlock/conflict counters from pg_stat_database',
        );

        // ------------------------------------------------------------------
        // 6. Per-relation lock summary (relations with the most waiting locks)
        // ------------------------------------------------------------------
        const relationLockRows = await queryRowsOrEmpty(
          `
          SELECT
            n.nspname                               AS schema_name,
            c.relname                               AS relation_name,
            c.relkind                               AS relation_kind,
            COUNT(*) FILTER (WHERE l.granted)       AS granted_locks,
            COUNT(*) FILTER (WHERE NOT l.granted)   AS waiting_locks,
            COUNT(*)                                AS total_locks
          FROM pg_locks l
          LEFT JOIN pg_class      c ON c.oid     = l.relation
          LEFT JOIN pg_namespace  n ON n.oid     = c.relnamespace
          WHERE l.relation IS NOT NULL
            AND l.pid <> pg_backend_pid()
          GROUP BY n.nspname, c.relname, c.relkind
          HAVING COUNT(*) FILTER (WHERE NOT l.granted) > 0
             OR  COUNT(*) > 2
          ORDER BY waiting_locks DESC, total_locks DESC
          LIMIT ${limit}
        `,
          'Unable to collect per-relation lock summary from pg_locks',
        );

        return {
          capturedAt: new Date().toISOString(),
          blockingChains: blockingChainRows.map((row) => ({
            blockedPid: toNumber(row['blocked_pid']) ?? 0,
            blockedUser: toString(row['blocked_user']) ?? 'unknown',
            blockedApp: toString(row['blocked_app']) ?? 'unknown',
            blockedState: toString(row['blocked_state']) ?? 'unknown',
            blockedDurationSeconds:
              toNumber(row['blocked_duration_seconds']) ?? 0,
            blockedQuery: toString(row['blocked_query']) ?? '',
            blockerPid: toNumber(row['blocker_pid']) ?? 0,
            blockerUser: toString(row['blocker_user']) ?? 'unknown',
            blockerApp: toString(row['blocker_app']) ?? 'unknown',
            blockerState: toString(row['blocker_state']) ?? 'unknown',
            blockerDurationSeconds:
              toNumber(row['blocker_duration_seconds']) ?? 0,
            blockerQuery: toString(row['blocker_query']) ?? '',
          })),
          idleInTransactionSessions: idleInTransactionRows.map((row) => ({
            pid: toNumber(row['pid']) ?? 0,
            userName: toString(row['user_name']) ?? 'unknown',
            applicationName: toString(row['application_name']) ?? 'unknown',
            state: toString(row['state']) ?? 'unknown',
            idleInTransactionSeconds:
              toNumber(row['idle_in_transaction_seconds']) ?? 0,
            lastQuery: toString(row['last_query']) ?? '',
            waitEventType: toString(row['wait_event_type']) ?? null,
            waitEvent: toString(row['wait_event']) ?? null,
          })),
          lockTypeDistribution: lockTypeRows.map((row) => ({
            locktype: toString(row['locktype']) ?? 'unknown',
            mode: toString(row['mode']) ?? 'unknown',
            granted:
              row['granted'] === true ||
              row['granted'] === 't' ||
              row['granted'] === 1,
            lockCount: toNumber(row['lock_count']) ?? 0,
          })),
          longRunningQueries: longRunningRows.map((row) => ({
            pid: toNumber(row['pid']) ?? 0,
            userName: toString(row['user_name']) ?? 'unknown',
            applicationName: toString(row['application_name']) ?? 'unknown',
            state: toString(row['state']) ?? 'unknown',
            queryDurationSeconds: toNumber(row['query_duration_seconds']) ?? 0,
            waitEventType: toString(row['wait_event_type']) ?? null,
            waitEvent: toString(row['wait_event']) ?? null,
            query: toString(row['query']) ?? '',
          })),
          relationLockSummary: relationLockRows.map((row) => ({
            schema: toString(row['schema_name']) ?? 'unknown',
            relation: toString(row['relation_name']) ?? 'unknown',
            relationKind: toString(row['relation_kind']) ?? 'unknown',
            grantedLocks: toNumber(row['granted_locks']) ?? 0,
            waitingLocks: toNumber(row['waiting_locks']) ?? 0,
            totalLocks: toNumber(row['total_locks']) ?? 0,
          })),
          deadlockCount: toNumber(deadlockRow['deadlocks']) ?? 0,
          conflictCount: toNumber(deadlockRow['conflicts']) ?? 0,
          sourceNotes,
        };
      });
    },
  },
);
