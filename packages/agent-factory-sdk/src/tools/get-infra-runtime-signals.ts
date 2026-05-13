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
  'Collect PostgreSQL infra/VM/network/OS proxy signals (connections, waits, IO, checkpoints, and key runtime settings) to correlate with query analysis.';

function parseProcMeminfoTotalBytes(raw: string | null): number | null {
  if (!raw) return null;
  const match = raw.match(/^MemTotal:\s+(\d+)\s+kB$/im);
  if (!match?.[1]) return null;
  const kb = Number(match[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

function parseCgroupMemoryLimitBytes(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === 'max') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function countProcCpuinfoProcessors(raw: string | null): number | null {
  if (!raw) return null;
  const matches = raw.match(/^processor\s*:/gim);
  return matches && matches.length > 0 ? matches.length : null;
}

function parseCpuSetCount(raw: string | null): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  let total = 0;
  for (const part of trimmed.split(',')) {
    const segment = part.trim();
    if (!segment) continue;
    const rangeMatch = segment.match(/^(\d+)-(\d+)$/);
    if (rangeMatch?.[1] && rangeMatch[2]) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        total += end - start + 1;
        continue;
      }
    }

    const single = Number(segment);
    if (Number.isFinite(single)) {
      total += 1;
    }
  }

  return total > 0 ? total : null;
}

function formatSettingValue(
  setting: string | null,
  unit: string | null,
): string | null {
  if (!setting) return null;
  if (!unit) return setting;
  return `${setting} ${unit}`;
}

export const GetInfraRuntimeSignalsTool = Tool.define(
  'get_infra_runtime_signals',
  {
    description: DESCRIPTION,
    parameters: z.object({
      waitLimit: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe(
          'Maximum number of wait event groups to return (default: 10).',
        ),
      ioLimit: z
        .number()
        .int()
        .positive()
        .max(20)
        .optional()
        .describe(
          'Maximum number of pg_stat_io backend/object rows to return (default: 10).',
        ),
    }),
    async execute(params, ctx) {
      const waitLimit = toSafeLimit(params.waitLimit, 10, 20);
      const ioLimit = toSafeLimit(params.ioLimit, 10, 20);

      return withDatasourceDriver(ctx, async ({ datasource, query }) => {
        if (!isPostgresDatasource(datasource)) {
          throw new Error(
            `This tool currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
          );
        }

        const sourceNotes: string[] = [];

        const queryRowsOrEmpty = async (
          sql: string,
          sourceNotePrefix: string,
        ): Promise<Array<Record<string, unknown>>> => {
          try {
            const result = await query(sql);
            return result.rows;
          } catch (error) {
            sourceNotes.push(
              `${sourceNotePrefix} (${getErrorMessage(error)}).`,
            );
            return [];
          }
        };

        const queryOneOrEmpty = async (
          sql: string,
          sourceNotePrefix: string,
        ): Promise<Record<string, unknown>> => {
          const rows = await queryRowsOrEmpty(sql, sourceNotePrefix);
          return rows[0] ?? {};
        };

        const runtimeRow = await queryOneOrEmpty(
          `
          SELECT
            current_database() AS database_name,
            current_setting('server_version') AS server_version,
            EXTRACT(EPOCH FROM (clock_timestamp() - pg_postmaster_start_time()))::double precision AS uptime_seconds,
            current_setting('max_connections')::int AS max_connections
        `,
          'Unable to collect PostgreSQL runtime snapshot',
        );

        const runtimeMetadataRow = await queryOneOrEmpty(
          `
          SELECT
            current_setting('data_directory', true) AS data_directory,
            current_setting('config_file', true) AS config_file,
            current_setting('hba_file', true) AS hba_file,
            COALESCE(inet_server_addr()::text, 'local') AS server_address,
            inet_server_port() AS server_port
        `,
          'Unable to collect PostgreSQL runtime metadata',
        );

        const hostMetadataRow = await queryOneOrEmpty(
          `
          SELECT
            pg_read_file('/proc/meminfo', 0, 8192, true) AS proc_meminfo,
            pg_read_file('/sys/fs/cgroup/memory.max', 0, 128, true) AS cgroup_memory_max,
            pg_read_file('/proc/cpuinfo', 0, 1048576, true) AS proc_cpuinfo,
            pg_read_file('/sys/fs/cgroup/cpuset.cpus.effective', 0, 256, true) AS cpuset_cpus_effective
        `,
          'Unable to collect PostgreSQL host/container resource metadata',
        );

        const connectionRow = await queryOneOrEmpty(
          `
          SELECT
            COUNT(*)::bigint AS total_sessions,
            COUNT(*) FILTER (WHERE state = 'active')::bigint AS active_sessions,
            COUNT(*) FILTER (WHERE state = 'idle')::bigint AS idle_sessions,
            COUNT(*) FILTER (WHERE state = 'active' AND wait_event_type IS NOT NULL)::bigint AS waiting_active_sessions,
            COUNT(*) FILTER (WHERE state = 'active' AND wait_event_type IS NULL)::bigint AS running_active_sessions
          FROM pg_stat_activity
          WHERE pid <> pg_backend_pid()
        `,
          'Unable to collect pg_stat_activity session counts',
        );

        const waitTypeRows = await queryRowsOrEmpty(
          `
          SELECT
            COALESCE(wait_event_type, 'CPU/Run') AS wait_event_type,
            COUNT(*)::bigint AS sessions
          FROM pg_stat_activity
          WHERE state = 'active'
            AND pid <> pg_backend_pid()
          GROUP BY COALESCE(wait_event_type, 'CPU/Run')
          ORDER BY sessions DESC
          LIMIT ${waitLimit}
        `,
          'Unable to collect wait_event_type distribution from pg_stat_activity',
        );

        const waitEventRows = await queryRowsOrEmpty(
          `
          SELECT
            COALESCE(wait_event, 'none') AS wait_event,
            COUNT(*)::bigint AS sessions
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event IS NOT NULL
            AND pid <> pg_backend_pid()
          GROUP BY COALESCE(wait_event, 'none')
          ORDER BY sessions DESC
          LIMIT ${waitLimit}
        `,
          'Unable to collect wait_event distribution from pg_stat_activity',
        );

        const waitCategoryRow = await queryOneOrEmpty(
          `
          SELECT
            COUNT(*) FILTER (WHERE wait_event_type = 'Lock')::bigint AS lock_wait_sessions,
            COUNT(*) FILTER (WHERE wait_event_type = 'IO')::bigint AS io_wait_sessions,
            COUNT(*) FILTER (WHERE wait_event IN ('ClientRead', 'ClientWrite'))::bigint AS network_wait_sessions,
            COUNT(*) FILTER (WHERE wait_event = 'ClientRead')::bigint AS client_read_wait_sessions,
            COUNT(*) FILTER (WHERE wait_event = 'ClientWrite')::bigint AS client_write_wait_sessions
          FROM pg_stat_activity
          WHERE state = 'active'
            AND pid <> pg_backend_pid()
        `,
          'Unable to collect wait-category counters from pg_stat_activity',
        );

        const ioRow = await queryOneOrEmpty(
          `
          SELECT
            blks_read,
            blks_hit,
            temp_files,
            temp_bytes,
            deadlocks,
            blk_read_time,
            blk_write_time
          FROM pg_stat_database
          WHERE datname = current_database()
        `,
          'Unable to collect pg_stat_database IO counters',
        );

        const checkpointRow = await queryOneOrEmpty(
          `
          SELECT
            checkpoints_timed,
            checkpoints_req,
            checkpoint_write_time,
            checkpoint_sync_time,
            buffers_checkpoint,
            buffers_backend,
            buffers_alloc
          FROM pg_stat_bgwriter
        `,
          'Unable to collect pg_stat_bgwriter checkpoint counters',
        );

        const settingsRows = await queryRowsOrEmpty(
          `
          SELECT
            name,
            setting,
            COALESCE(unit, '') AS unit
          FROM pg_settings
          WHERE name IN (
            'shared_buffers',
            'work_mem',
            'maintenance_work_mem',
            'effective_cache_size',
            'max_wal_size',
            'checkpoint_timeout',
            'track_io_timing',
            'effective_io_concurrency',
            'random_page_cost',
            'autovacuum',
            'max_worker_processes',
            'max_parallel_workers',
            'max_parallel_workers_per_gather',
            'hash_mem_multiplier',
            'jit',
            'autovacuum_max_workers',
            'autovacuum_work_mem',
            'checkpoint_completion_target',
            'tcp_keepalives_idle',
            'tcp_keepalives_interval',
            'tcp_keepalives_count',
            'logging_collector',
            'log_destination',
            'log_directory',
            'log_filename',
            'log_min_duration_statement',
            'log_statement',
            'log_checkpoints',
            'log_lock_waits',
            'log_temp_files',
            'log_autovacuum_min_duration'
          )
        `,
          'Unable to collect PostgreSQL settings from pg_settings',
        );

        let ioByBackend: Array<{
          backendType: string;
          object: string;
          reads: number;
          writes: number;
          writebacks: number;
          extends: number;
          fsyncs: number;
          hits: number;
          evictions: number;
          reuses: number;
        }> = [];

        try {
          const ioByBackendResult = await query(`
            SELECT
              backend_type,
              object,
              SUM(reads)::bigint AS reads,
              SUM(writes)::bigint AS writes,
              SUM(writebacks)::bigint AS writebacks,
              SUM(extends)::bigint AS extends,
              SUM(fsyncs)::bigint AS fsyncs,
              SUM(hits)::bigint AS hits,
              SUM(evictions)::bigint AS evictions,
              SUM(reuses)::bigint AS reuses
            FROM pg_stat_io
            GROUP BY backend_type, object
            ORDER BY (SUM(reads) + SUM(writes) + SUM(fsyncs)) DESC
            LIMIT ${ioLimit}
          `);

          ioByBackend = ioByBackendResult.rows.map((row) => ({
            backendType: toString(row['backend_type']) ?? 'unknown',
            object: toString(row['object']) ?? 'unknown',
            reads: toNumber(row['reads']) ?? 0,
            writes: toNumber(row['writes']) ?? 0,
            writebacks: toNumber(row['writebacks']) ?? 0,
            extends: toNumber(row['extends']) ?? 0,
            fsyncs: toNumber(row['fsyncs']) ?? 0,
            hits: toNumber(row['hits']) ?? 0,
            evictions: toNumber(row['evictions']) ?? 0,
            reuses: toNumber(row['reuses']) ?? 0,
          }));
        } catch (error) {
          sourceNotes.push(
            `pg_stat_io is unavailable (version/permission dependent); IO backend granularity is reduced (${getErrorMessage(error)}).`,
          );
        }

        const maxConnections = toNumber(runtimeRow['max_connections']) ?? 0;
        const totalSessions = toNumber(connectionRow['total_sessions']) ?? 0;
        const activeSessions = toNumber(connectionRow['active_sessions']) ?? 0;
        const waitingActiveSessions =
          toNumber(connectionRow['waiting_active_sessions']) ?? 0;
        const runningActiveSessions =
          toNumber(connectionRow['running_active_sessions']) ?? 0;
        const utilizationPct =
          maxConnections > 0
            ? Number(((totalSessions / maxConnections) * 100).toFixed(2))
            : 0;

        const lockWaitSessions =
          toNumber(waitCategoryRow['lock_wait_sessions']) ?? 0;
        const ioWaitSessions =
          toNumber(waitCategoryRow['io_wait_sessions']) ?? 0;
        const networkWaitSessions =
          toNumber(waitCategoryRow['network_wait_sessions']) ?? 0;
        const clientReadWaitSessions =
          toNumber(waitCategoryRow['client_read_wait_sessions']) ?? 0;
        const clientWriteWaitSessions =
          toNumber(waitCategoryRow['client_write_wait_sessions']) ?? 0;

        const blksRead = toNumber(ioRow['blks_read']) ?? 0;
        const blksHit = toNumber(ioRow['blks_hit']) ?? 0;
        const cacheHitPct =
          blksRead + blksHit > 0
            ? Number(((blksHit / (blksHit + blksRead)) * 100).toFixed(2))
            : 100;

        const settingsMap = new Map<string, string | null>();
        const rawSettingsMap = new Map<string, string>();
        for (const row of settingsRows) {
          const name = toString(row['name']);
          if (!name) continue;
          const setting = toString(row['setting']);
          if (setting) {
            rawSettingsMap.set(name, setting);
          }

          settingsMap.set(
            name,
            formatSettingValue(
              setting,
              (toString(row['unit']) ?? '').trim() || null,
            ),
          );
        }

        if ((settingsMap.get('track_io_timing') ?? '').startsWith('off')) {
          sourceNotes.push(
            'track_io_timing is off; blk_read_time/blk_write_time may not represent real storage latency.',
          );
        }

        const totalMemoryBytes = parseProcMeminfoTotalBytes(
          toString(hostMetadataRow['proc_meminfo']),
        );
        const cgroupMemoryLimitBytes = parseCgroupMemoryLimitBytes(
          toString(hostMetadataRow['cgroup_memory_max']),
        );
        const logicalCpuCount =
          parseCpuSetCount(toString(hostMetadataRow['cpuset_cpus_effective'])) ??
          countProcCpuinfoProcessors(toString(hostMetadataRow['proc_cpuinfo']));

        return {
          capturedAt: new Date().toISOString(),
          database: toString(runtimeRow['database_name']) ?? 'unknown',
          postgresVersion: toString(runtimeRow['server_version']) ?? 'unknown',
          os: {
            uptimeSeconds: toNumber(runtimeRow['uptime_seconds']) ?? 0,
            dataDirectory: toString(runtimeMetadataRow['data_directory']),
            configFile: toString(runtimeMetadataRow['config_file']),
            hbaFile: toString(runtimeMetadataRow['hba_file']),
            serverAddress: toString(runtimeMetadataRow['server_address']),
            serverPort: toNumber(runtimeMetadataRow['server_port']),
            totalMemoryBytes,
            cgroupMemoryLimitBytes,
          },
          connection: {
            maxConnections,
            totalSessions,
            activeSessions,
            idleSessions: toNumber(connectionRow['idle_sessions']) ?? 0,
            waitingActiveSessions,
            utilizationPct,
          },
          cpu: {
            runningActiveSessions,
            waitingActiveSessions,
            maxWorkerProcesses:
              toNumber(rawSettingsMap.get('max_worker_processes')) ?? null,
            maxParallelWorkers:
              toNumber(rawSettingsMap.get('max_parallel_workers')) ?? null,
            maxParallelWorkersPerGather:
              toNumber(rawSettingsMap.get('max_parallel_workers_per_gather')) ??
              null,
            logicalCpuCount,
            jit: settingsMap.get('jit') ?? null,
          },
          network: {
            networkWaitSessions,
            clientReadWaitSessions,
            clientWriteWaitSessions,
            tcpKeepalivesIdle: settingsMap.get('tcp_keepalives_idle') ?? null,
            tcpKeepalivesInterval:
              settingsMap.get('tcp_keepalives_interval') ?? null,
            tcpKeepalivesCount: settingsMap.get('tcp_keepalives_count') ?? null,
          },
          waits: {
            lockWaitSessions,
            ioWaitSessions,
            networkWaitSessions,
            activeWaitEventTypes: waitTypeRows.map((row) => {
              const sessions = toNumber(row['sessions']) ?? 0;
              const pctOfActiveSessions =
                activeSessions > 0
                  ? Number(((sessions / activeSessions) * 100).toFixed(2))
                  : 0;

              return {
                waitEventType: toString(row['wait_event_type']) ?? 'unknown',
                sessions,
                pctOfActiveSessions,
              };
            }),
            activeWaitEvents: waitEventRows.map((row) => ({
              waitEvent: toString(row['wait_event']) ?? 'unknown',
              sessions: toNumber(row['sessions']) ?? 0,
            })),
          },
          io: {
            blksRead,
            blksHit,
            cacheHitPct,
            tempFiles: toNumber(ioRow['temp_files']) ?? 0,
            tempBytes: toNumber(ioRow['temp_bytes']) ?? 0,
            deadlocks: toNumber(ioRow['deadlocks']) ?? 0,
            blockReadTimeMs: toNumber(ioRow['blk_read_time']) ?? 0,
            blockWriteTimeMs: toNumber(ioRow['blk_write_time']) ?? 0,
          },
          checkpoints: {
            checkpointsTimed: toNumber(checkpointRow['checkpoints_timed']) ?? 0,
            checkpointsRequested:
              toNumber(checkpointRow['checkpoints_req']) ?? 0,
            checkpointWriteTimeMs:
              toNumber(checkpointRow['checkpoint_write_time']) ?? 0,
            checkpointSyncTimeMs:
              toNumber(checkpointRow['checkpoint_sync_time']) ?? 0,
            buffersCheckpoint:
              toNumber(checkpointRow['buffers_checkpoint']) ?? 0,
            buffersBackend: toNumber(checkpointRow['buffers_backend']) ?? 0,
            buffersAlloc: toNumber(checkpointRow['buffers_alloc']) ?? 0,
          },
          config: {
            sharedBuffers: settingsMap.get('shared_buffers') ?? null,
            workMem: settingsMap.get('work_mem') ?? null,
            maintenanceWorkMem: settingsMap.get('maintenance_work_mem') ?? null,
            effectiveCacheSize: settingsMap.get('effective_cache_size') ?? null,
            maxWalSize: settingsMap.get('max_wal_size') ?? null,
            checkpointTimeout: settingsMap.get('checkpoint_timeout') ?? null,
            checkpointCompletionTarget:
              settingsMap.get('checkpoint_completion_target') ?? null,
            trackIoTiming: settingsMap.get('track_io_timing') ?? null,
            effectiveIoConcurrency:
              settingsMap.get('effective_io_concurrency') ?? null,
            randomPageCost: settingsMap.get('random_page_cost') ?? null,
            hashMemMultiplier:
              settingsMap.get('hash_mem_multiplier') ?? null,
            autovacuumMaxWorkers:
              settingsMap.get('autovacuum_max_workers') ?? null,
            autovacuumWorkMem:
              settingsMap.get('autovacuum_work_mem') ?? null,
            autovacuum: settingsMap.get('autovacuum') ?? null,
          },
          logging: {
            loggingCollector: settingsMap.get('logging_collector') ?? null,
            logDestination: settingsMap.get('log_destination') ?? null,
            logDirectory: settingsMap.get('log_directory') ?? null,
            logFilename: settingsMap.get('log_filename') ?? null,
            logMinDurationStatement:
              settingsMap.get('log_min_duration_statement') ?? null,
            logStatement: settingsMap.get('log_statement') ?? null,
            logCheckpoints: settingsMap.get('log_checkpoints') ?? null,
            logLockWaits: settingsMap.get('log_lock_waits') ?? null,
            logTempFiles: settingsMap.get('log_temp_files') ?? null,
            logAutovacuumMinDuration:
              settingsMap.get('log_autovacuum_min_duration') ?? null,
          },
          ioByBackend,
          sourceNotes,
        };
      });
    },
  },
);
