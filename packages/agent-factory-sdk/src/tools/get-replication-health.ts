import { z } from 'zod';
import { Tool } from './tool';
import {
  isPostgresDatasource,
  toNumber,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';

const DESCRIPTION =
  'Assess PostgreSQL replication health: streaming standby lag, replication slot status and retained WAL, WAL generation rate (PG14+). Returns gracefully empty results when no replication is configured.';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    const firstLine = error.message.split('\n')[0]?.trim();
    return firstLine || 'unknown error';
  }
  return 'unknown error';
}

export const GetReplicationHealthTool = Tool.define('get_replication_health', {
  description: DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `db-performance-audit currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
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
      // 1. Streaming replication standbys via pg_stat_replication
      //    pg_wal_lsn_diff gives byte-level lag between sent and replayed
      //    LSN so we can surface both the lag distance and the interval.
      // ------------------------------------------------------------------
      const replicationRows = await queryRowsOrEmpty(
        `
        SELECT
          pid,
          usename                                                         AS user_name,
          application_name,
          client_addr::text                                               AS client_address,
          state,
          sync_state,
          sent_lsn::text                                                  AS sent_lsn,
          write_lsn::text                                                 AS write_lsn,
          flush_lsn::text                                                 AS flush_lsn,
          replay_lsn::text                                                AS replay_lsn,
          pg_wal_lsn_diff(sent_lsn,  write_lsn)::bigint                  AS write_lag_bytes,
          pg_wal_lsn_diff(sent_lsn,  flush_lsn)::bigint                  AS flush_lag_bytes,
          pg_wal_lsn_diff(sent_lsn,  replay_lsn)::bigint                 AS replay_lag_bytes,
          write_lag::text                                                 AS write_lag_interval,
          flush_lag::text                                                 AS flush_lag_interval,
          replay_lag::text                                                AS replay_lag_interval,
          reply_time::text                                                AS last_reply_time
        FROM pg_stat_replication
        ORDER BY replay_lag_bytes DESC NULLS LAST
      `,
        'Unable to collect streaming replication status from pg_stat_replication',
      );

      // ------------------------------------------------------------------
      // 2. Replication slots — inactive or lagging slots can cause WAL
      //    accumulation and disk exhaustion on the primary.
      // ------------------------------------------------------------------
      const slotRows = await queryRowsOrEmpty(
        `
        SELECT
          slot_name,
          plugin,
          slot_type,
          database,
          active,
          active_pid,
          xmin::text                                                      AS xmin,
          catalog_xmin::text                                              AS catalog_xmin,
          restart_lsn::text                                               AS restart_lsn,
          confirmed_flush_lsn::text                                       AS confirmed_flush_lsn,
          COALESCE(
            pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)::bigint,
            0
          )                                                               AS retained_wal_bytes,
          wal_status,
          safe_wal_size,
          two_phase,
          temporary
        FROM pg_replication_slots
        ORDER BY retained_wal_bytes DESC
      `,
        'Unable to collect replication slot status from pg_replication_slots',
      );

      // ------------------------------------------------------------------
      // 3. WAL generation stats (PostgreSQL 14+)
      //    Useful for estimating how fast WAL is produced — high
      //    wal_bytes combined with many checkpoints_req is a
      //    WAL pressure signal.
      // ------------------------------------------------------------------
      const walStatsRow = await queryOneOrEmpty(
        `
        SELECT
          wal_records,
          wal_fpi,
          wal_bytes,
          wal_buffers_full,
          wal_write,
          wal_sync,
          wal_write_time,
          wal_sync_time,
          stats_reset::text   AS stats_reset
        FROM pg_stat_wal
      `,
        'Unable to collect WAL generation stats from pg_stat_wal (requires PostgreSQL 14+)',
      );

      // ------------------------------------------------------------------
      // 4. Current WAL position — gives byte context for lag figures
      // ------------------------------------------------------------------
      const walPositionRow = await queryOneOrEmpty(
        `
        SELECT
          pg_current_wal_lsn()::text         AS current_wal_lsn,
          pg_current_wal_insert_lsn()::text  AS current_wal_insert_lsn,
          pg_walfile_name(pg_current_wal_lsn()) AS current_wal_file
      `,
        'Unable to collect current WAL position',
      );

      // ------------------------------------------------------------------
      // 5. pg_stat_wal_receiver — if this is a standby, show receiver stats
      // ------------------------------------------------------------------
      const walReceiverRow = await queryOneOrEmpty(
        `
        SELECT
          pid,
          status,
          receive_start_lsn::text        AS receive_start_lsn,
          received_lsn::text             AS received_lsn,
          last_msg_send_time::text       AS last_msg_send_time,
          last_msg_receipt_time::text    AS last_msg_receipt_time,
          latest_end_lsn::text           AS latest_end_lsn,
          latest_end_time::text          AS latest_end_time,
          slot_name,
          sender_host,
          sender_port,
          conninfo
        FROM pg_stat_wal_receiver
      `,
        'Unable to collect WAL receiver stats from pg_stat_wal_receiver (not applicable on primary or no replication)',
      );

      // ------------------------------------------------------------------
      // Determine overall replication topology
      // ------------------------------------------------------------------
      const hasStreamingStandbys = replicationRows.length > 0;
      const hasReplicationSlots = slotRows.length > 0;
      const isStandby = Object.keys(walReceiverRow).length > 0;
      const hasReplication =
        hasStreamingStandbys || hasReplicationSlots || isStandby;

      if (!hasReplication) {
        sourceNotes.push(
          'No active replication connections, slots, or WAL receiver detected. This instance appears to be a standalone primary with no configured replication.',
        );
      }

      // Flag dangerous slot conditions
      for (const row of slotRows) {
        const walStatus = toString(row['wal_status']);
        const retainedBytes = toNumber(row['retained_wal_bytes']) ?? 0;
        const active =
          row['active'] === true ||
          row['active'] === 't' ||
          row['active'] === 1;

        if (!active) {
          sourceNotes.push(
            `Replication slot '${toString(row['slot_name'])}' is INACTIVE and retaining ${retainedBytes} WAL bytes — risk of disk exhaustion if not monitored.`,
          );
        }
        if (walStatus === 'lost') {
          sourceNotes.push(
            `Replication slot '${toString(row['slot_name'])}' has wal_status='lost' — WAL needed by this slot has already been removed.`,
          );
        }
        if (walStatus === 'unreserved') {
          sourceNotes.push(
            `Replication slot '${toString(row['slot_name'])}' has wal_status='unreserved' — WAL retention is not guaranteed; risk of slot invalidation under heavy write load.`,
          );
        }
      }

      return {
        capturedAt: new Date().toISOString(),
        hasReplication,
        hasStreamingStandbys,
        hasReplicationSlots,
        isStandby,
        currentWalLsn: toString(walPositionRow['current_wal_lsn']) ?? null,
        currentWalInsertLsn:
          toString(walPositionRow['current_wal_insert_lsn']) ?? null,
        currentWalFile: toString(walPositionRow['current_wal_file']) ?? null,
        streamingStandbys: replicationRows.map((row) => ({
          pid: toNumber(row['pid']) ?? 0,
          userName: toString(row['user_name']) ?? 'unknown',
          applicationName: toString(row['application_name']) ?? 'unknown',
          clientAddress: toString(row['client_address']) ?? 'unknown',
          state: toString(row['state']) ?? 'unknown',
          syncState: toString(row['sync_state']) ?? 'unknown',
          sentLsn: toString(row['sent_lsn']) ?? null,
          writeLsn: toString(row['write_lsn']) ?? null,
          flushLsn: toString(row['flush_lsn']) ?? null,
          replayLsn: toString(row['replay_lsn']) ?? null,
          writeLagBytes: toNumber(row['write_lag_bytes']) ?? 0,
          flushLagBytes: toNumber(row['flush_lag_bytes']) ?? 0,
          replayLagBytes: toNumber(row['replay_lag_bytes']) ?? 0,
          writeLagInterval: toString(row['write_lag_interval']) ?? null,
          flushLagInterval: toString(row['flush_lag_interval']) ?? null,
          replayLagInterval: toString(row['replay_lag_interval']) ?? null,
          lastReplyTime: toString(row['last_reply_time']) ?? null,
        })),
        replicationSlots: slotRows.map((row) => ({
          slotName: toString(row['slot_name']) ?? 'unknown',
          plugin: toString(row['plugin']) ?? null,
          slotType: toString(row['slot_type']) ?? 'unknown',
          database: toString(row['database']) ?? null,
          active:
            row['active'] === true ||
            row['active'] === 't' ||
            row['active'] === 1,
          activePid: toNumber(row['active_pid']) ?? null,
          restartLsn: toString(row['restart_lsn']) ?? null,
          confirmedFlushLsn: toString(row['confirmed_flush_lsn']) ?? null,
          retainedWalBytes: toNumber(row['retained_wal_bytes']) ?? 0,
          walStatus: toString(row['wal_status']) ?? null,
          safeWalSize: toNumber(row['safe_wal_size']) ?? null,
          twoPhase:
            row['two_phase'] === true ||
            row['two_phase'] === 't' ||
            row['two_phase'] === 1,
          temporary:
            row['temporary'] === true ||
            row['temporary'] === 't' ||
            row['temporary'] === 1,
        })),
        walStats:
          Object.keys(walStatsRow).length > 0
            ? {
                walRecords: toNumber(walStatsRow['wal_records']) ?? null,
                walFpi: toNumber(walStatsRow['wal_fpi']) ?? null,
                walBytes: toNumber(walStatsRow['wal_bytes']) ?? null,
                walBuffersFull:
                  toNumber(walStatsRow['wal_buffers_full']) ?? null,
                walWrite: toNumber(walStatsRow['wal_write']) ?? null,
                walSync: toNumber(walStatsRow['wal_sync']) ?? null,
                walWriteTimeMs: toNumber(walStatsRow['wal_write_time']) ?? null,
                walSyncTimeMs: toNumber(walStatsRow['wal_sync_time']) ?? null,
                statsReset: toString(walStatsRow['stats_reset']) ?? null,
              }
            : null,
        walReceiver:
          Object.keys(walReceiverRow).length > 0
            ? {
                pid: toNumber(walReceiverRow['pid']) ?? null,
                status: toString(walReceiverRow['status']) ?? null,
                receiveStartLsn:
                  toString(walReceiverRow['receive_start_lsn']) ?? null,
                receivedLsn: toString(walReceiverRow['received_lsn']) ?? null,
                lastMsgSendTime:
                  toString(walReceiverRow['last_msg_send_time']) ?? null,
                lastMsgReceiptTime:
                  toString(walReceiverRow['last_msg_receipt_time']) ?? null,
                latestEndLsn:
                  toString(walReceiverRow['latest_end_lsn']) ?? null,
                latestEndTime:
                  toString(walReceiverRow['latest_end_time']) ?? null,
                slotName: toString(walReceiverRow['slot_name']) ?? null,
                senderHost: toString(walReceiverRow['sender_host']) ?? null,
                senderPort: toNumber(walReceiverRow['sender_port']) ?? null,
              }
            : null,
        sourceNotes,
      };
    });
  },
});
