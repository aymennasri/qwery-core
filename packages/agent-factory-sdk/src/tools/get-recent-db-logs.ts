import { z } from 'zod';

import {
  getErrorMessage,
  isPostgresDatasource,
  toNumber,
  toSafeLimit,
  toString,
  withDatasourceDriver,
} from './db-audit/shared';
import { Tool } from './tool';

const DESCRIPTION =
  'Collect recent PostgreSQL log-derived signals (slow statements, errors, lock waits, temp files, checkpoints). Supports multiple log_line_prefix formats and JSON-format logs (PostgreSQL 15+). Falls back gracefully when pg_read_file is unavailable.';

// ---------------------------------------------------------------------------
// Log prefix format detection — ordered from most to least specific
// We try each regex in order; the first match wins.
// ---------------------------------------------------------------------------
const PREFIX_FORMATS: Array<{
  label: string;
  regex: RegExp;
  groups: { timestamp?: number; pid?: number; level?: number; message: number };
}> = [
  // JSON format: { "timestamp": "...", "pid": 123, "error_severity": "LOG", "message": "..." }
  // Handled separately — not in this list.

  // Format: 2024-01-15 12:34:56.789 UTC [1234] LOG:  message
  {
    label: '%t [%p] %l',
    regex:
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+\w+)?)\s+\[(\d+)\]\s+([A-Z]+):\s+(.*)$/,
    groups: { timestamp: 1, pid: 2, level: 3, message: 4 },
  },
  // Format: 2024-01-15 12:34:56 UTC [1234] user@db [LOG]: message
  {
    label: '%t [%p] %u@%d [%l]',
    regex:
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+\w+)?)\s+\[(\d+)\]\s+\S+\s+\[([A-Z]+)\]:\s*(.*)$/,
    groups: { timestamp: 1, pid: 2, level: 3, message: 4 },
  },
  // Format: 2024-01-15 12:34:56.789 [1234-1] user@db LOG:  message
  {
    label: '%m [%p-%l] %q%u@%d',
    regex:
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+\w+)?)\s+\[\d+-\d+\]\s+\S+\s+([A-Z]+):\s+(.*)$/,
    groups: { timestamp: 1, level: 2, message: 3 },
  },
  // Format: 2024-01-15 12:34:56 UTC [1234] LOG:  message  (no user@db)
  {
    label: '%t [%p]',
    regex:
      /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:\s+\w+)?)\s+\[(\d+)\]\s+([A-Z]+):\s*(.*)$/,
    groups: { timestamp: 1, pid: 2, level: 3, message: 4 },
  },
  // Format: [1234]: 2024-01-15 12:34:56 LOG message  (syslog-style)
  {
    label: 'syslog-like',
    regex:
      /^\[(\d+)\]:\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)\s+([A-Z]+)\s+(.*)$/,
    groups: { pid: 1, timestamp: 2, level: 3, message: 4 },
  },
  // Format: LOG:  message  (no timestamp/pid prefix at all)
  {
    label: 'level-only',
    regex: /^([A-Z]+):\s+(.*)$/,
    groups: { level: 1, message: 2 },
  },
];

const SLOW_STATEMENT_REGEX =
  /duration:\s*([0-9]+(?:\.[0-9]+)?)\s*ms\s+(?:execute[^:]*:|statement:)\s*([\s\S]+)$/i;
const CHECKPOINT_REGEX = /checkpoint\s+(starting|complete|warning)\b/i;
const LOCK_WAIT_REGEX =
  /(still waiting for|deadlock detected|could not obtain lock|canceling statement due to lock timeout|canceling statement due to deadlock|lock not available)/i;
const TEMP_FILE_SIZE_REGEX = /\bsize\s+([0-9]+)\b/i;
const AUTOVACUUM_REGEX = /automatic (vacuum|analyze) of table/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ParsedLogLine = {
  raw: string;
  timestamp: string | null;
  pid: number | null;
  level: string | null;
  message: string;
  formatLabel: string | null;
};

type SlowStatementEvent = {
  timestamp: string | null;
  pid: number | null;
  durationMs: number;
  statement: string;
};

type ErrorEvent = {
  timestamp: string | null;
  pid: number | null;
  level: string;
  message: string;
  statement: string | null;
};

type LockWaitEvent = {
  timestamp: string | null;
  pid: number | null;
  message: string;
};

type TempFileEvent = {
  timestamp: string | null;
  pid: number | null;
  sizeBytes: number | null;
  message: string;
};

type CheckpointEvent = {
  timestamp: string | null;
  pid: number | null;
  message: string;
};

type AutovacuumEvent = {
  timestamp: string | null;
  pid: number | null;
  message: string;
};

export type ParsedPostgresLogSignals = {
  linesScanned: number;
  formatDetected: string | null;
  counts: {
    slowStatements: number;
    errors: number;
    warnings: number;
    lockWaits: number;
    tempFiles: number;
    checkpoints: number;
    autovacuumEvents: number;
  };
  slowStatements: SlowStatementEvent[];
  errors: ErrorEvent[];
  lockWaitEvents: LockWaitEvent[];
  tempFileEvents: TempFileEvent[];
  checkpointEvents: CheckpointEvent[];
  autovacuumEvents: AutovacuumEvent[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateText(value: string, maxLength = 600): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(maxLength - 3, 0))}...`;
}

// ---------------------------------------------------------------------------
// JSON log parsing (PostgreSQL 15+ with log_destination='jsonlog')
// ---------------------------------------------------------------------------

function tryParseJsonLogLine(line: string): ParsedLogLine | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    const obj = JSON.parse(trimmed) as Record<string, unknown>;

    const timestamp =
      typeof obj['timestamp'] === 'string'
        ? obj['timestamp']
        : typeof obj['log_time'] === 'string'
          ? obj['log_time']
          : null;

    const pid =
      typeof obj['pid'] === 'number'
        ? obj['pid']
        : typeof obj['process_id'] === 'number'
          ? obj['process_id']
          : null;

    const level =
      typeof obj['error_severity'] === 'string'
        ? (obj['error_severity'] as string).toUpperCase()
        : typeof obj['severity'] === 'string'
          ? (obj['severity'] as string).toUpperCase()
          : null;

    const message =
      typeof obj['message'] === 'string'
        ? obj['message']
        : typeof obj['detail'] === 'string'
          ? obj['detail']
          : '';

    // Attach duration and statement from structured fields when present
    // so downstream regexes still work (reconstruct the canonical form).
    let reconstructed = message;
    if (
      typeof obj['duration_ms'] === 'number' &&
      typeof obj['statement'] === 'string'
    ) {
      reconstructed = `duration: ${(obj['duration_ms'] as number).toFixed(3)} ms  statement: ${obj['statement']}`;
    } else if (
      typeof obj['duration'] === 'string' &&
      typeof obj['statement'] === 'string'
    ) {
      reconstructed = `duration: ${obj['duration']}  statement: ${obj['statement']}`;
    }

    return {
      raw: trimmed,
      timestamp,
      pid,
      level,
      message: reconstructed || message,
      formatLabel: 'json',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Text log line parsing — tries each known prefix format in order
// ---------------------------------------------------------------------------

function detectAndParseLine(line: string): ParsedLogLine | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  // Try JSON first
  const json = tryParseJsonLogLine(trimmed);
  if (json) return json;

  for (const fmt of PREFIX_FORMATS) {
    const match = trimmed.match(fmt.regex);
    if (!match) continue;

    const g = fmt.groups;
    const timestamp =
      g.timestamp !== undefined ? (match[g.timestamp] ?? null) : null;
    const pidRaw = g.pid !== undefined ? match[g.pid] : undefined;
    const pid =
      pidRaw !== undefined
        ? Number.isNaN(Number.parseInt(pidRaw, 10))
          ? null
          : Number.parseInt(pidRaw, 10)
        : null;
    const level =
      g.level !== undefined
        ? ((match[g.level] ?? null)?.toUpperCase() ?? null)
        : null;
    const message = match[g.message] ?? trimmed;

    return {
      raw: trimmed,
      timestamp: timestamp?.trim() ?? null,
      pid,
      level,
      message: message.trim(),
      formatLabel: fmt.label,
    };
  }

  // Could not match any format — return the raw line as a message
  return {
    raw: trimmed,
    timestamp: null,
    pid: null,
    level: null,
    message: trimmed,
    formatLabel: null,
  };
}

// ---------------------------------------------------------------------------
// Core signal extractor
// ---------------------------------------------------------------------------

export function extractPostgresLogSignals(
  logContent: string,
  maxEvents: number,
): ParsedPostgresLogSignals {
  const allSlowStatements: SlowStatementEvent[] = [];
  const allErrors: ErrorEvent[] = [];
  const allLockWaitEvents: LockWaitEvent[] = [];
  const allTempFileEvents: TempFileEvent[] = [];
  const allCheckpointEvents: CheckpointEvent[] = [];
  const allAutovacuumEvents: AutovacuumEvent[] = [];

  let linesScanned = 0;
  let warningCount = 0;
  let pendingErrorIndex = -1;
  let formatDetected: string | null = null;

  const lines = logContent.split(/\r?\n/);

  for (const line of lines) {
    const parsed = detectAndParseLine(line);
    if (!parsed) continue;

    linesScanned += 1;

    // Track the first successfully detected format
    if (formatDetected === null && parsed.formatLabel !== null) {
      formatDetected = parsed.formatLabel;
    }

    const level = parsed.level ?? '';

    // ------------------------------------------------------------------
    // Error / Warning tracking with associated STATEMENT line
    // ------------------------------------------------------------------
    if (level === 'ERROR' || level === 'FATAL' || level === 'PANIC') {
      allErrors.push({
        timestamp: parsed.timestamp,
        pid: parsed.pid,
        level,
        message: truncateText(parsed.message),
        statement: null,
      });
      pendingErrorIndex = allErrors.length - 1;
    } else if (level === 'WARNING') {
      warningCount += 1;
      pendingErrorIndex = -1;
    } else if (level === 'STATEMENT' && pendingErrorIndex >= 0) {
      const pendingError = allErrors[pendingErrorIndex];
      if (pendingError && !pendingError.statement) {
        pendingError.statement = truncateText(parsed.message);
      }
      pendingErrorIndex = -1;
    } else if (
      level !== 'DETAIL' &&
      level !== 'HINT' &&
      level !== 'CONTEXT' &&
      level !== 'LOCATION'
    ) {
      pendingErrorIndex = -1;
    }

    // ------------------------------------------------------------------
    // Slow statement (duration: X ms  statement: ...)
    // ------------------------------------------------------------------
    const slowMatch = parsed.message.match(SLOW_STATEMENT_REGEX);
    if (slowMatch) {
      allSlowStatements.push({
        timestamp: parsed.timestamp,
        pid: parsed.pid,
        durationMs: Number.parseFloat(slowMatch[1] ?? '0') || 0,
        statement: truncateText(slowMatch[2]?.trim() ?? ''),
      });
    }

    // ------------------------------------------------------------------
    // Checkpoint events
    // ------------------------------------------------------------------
    if (CHECKPOINT_REGEX.test(parsed.message)) {
      allCheckpointEvents.push({
        timestamp: parsed.timestamp,
        pid: parsed.pid,
        message: truncateText(parsed.message),
      });
    }

    // ------------------------------------------------------------------
    // Lock wait / deadlock events
    // ------------------------------------------------------------------
    if (LOCK_WAIT_REGEX.test(parsed.message)) {
      allLockWaitEvents.push({
        timestamp: parsed.timestamp,
        pid: parsed.pid,
        message: truncateText(parsed.message),
      });
    }

    // ------------------------------------------------------------------
    // Temporary file events
    // ------------------------------------------------------------------
    if (
      parsed.message.toLowerCase().includes('temporary file:') ||
      parsed.message.toLowerCase().includes('temp file:')
    ) {
      const sizeMatch = parsed.message.match(TEMP_FILE_SIZE_REGEX);
      allTempFileEvents.push({
        timestamp: parsed.timestamp,
        pid: parsed.pid,
        sizeBytes: sizeMatch?.[1] ? Number.parseInt(sizeMatch[1], 10) : null,
        message: truncateText(parsed.message),
      });
    }

    // ------------------------------------------------------------------
    // Autovacuum / autoanalyze events
    // ------------------------------------------------------------------
    if (AUTOVACUUM_REGEX.test(parsed.message)) {
      allAutovacuumEvents.push({
        timestamp: parsed.timestamp,
        pid: parsed.pid,
        message: truncateText(parsed.message),
      });
    }
  }

  return {
    linesScanned,
    formatDetected,
    counts: {
      slowStatements: allSlowStatements.length,
      errors: allErrors.length,
      warnings: warningCount,
      lockWaits: allLockWaitEvents.length,
      tempFiles: allTempFileEvents.length,
      checkpoints: allCheckpointEvents.length,
      autovacuumEvents: allAutovacuumEvents.length,
    },
    slowStatements: allSlowStatements.slice(0, maxEvents),
    errors: allErrors.slice(0, maxEvents),
    lockWaitEvents: allLockWaitEvents.slice(0, maxEvents),
    tempFileEvents: allTempFileEvents.slice(0, maxEvents),
    checkpointEvents: allCheckpointEvents.slice(0, maxEvents),
    autovacuumEvents: allAutovacuumEvents.slice(0, maxEvents),
  };
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const GetRecentDbLogsTool = Tool.define('get_recent_db_logs', {
  description: DESCRIPTION,
  parameters: z.object({
    tailBytes: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional()
      .describe(
        'Approximate log bytes to inspect from the tail of current PostgreSQL log file (default: 262144 = 256 KB).',
      ),
    maxEvents: z
      .number()
      .int()
      .positive()
      .max(50)
      .optional()
      .describe('Maximum number of event samples per category (default: 15).'),
  }),
  async execute(params, ctx) {
    const tailBytes = toSafeLimit(params.tailBytes, 262144, 1024 * 1024);
    const maxEvents = toSafeLimit(params.maxEvents, 15, 50);

    return withDatasourceDriver(ctx, async ({ datasource, query }) => {
      if (!isPostgresDatasource(datasource)) {
        throw new Error(
          `This tool currently supports PostgreSQL datasources only. Received: ${datasource.datasource_provider}`,
        );
      }

      const sourceNotes: string[] = [];

      // ------------------------------------------------------------------
      // 1. Collect logging settings
      // ------------------------------------------------------------------
      let settingsRow: Record<string, unknown> = {};
      try {
        const settingsResult = await query(`
          SELECT
            current_setting('logging_collector',         true) AS logging_collector,
            current_setting('log_destination',           true) AS log_destination,
            current_setting('log_directory',             true) AS log_directory,
            current_setting('log_filename',              true) AS log_filename,
            current_setting('log_line_prefix',           true) AS log_line_prefix,
            current_setting('log_min_duration_statement',true) AS log_min_duration_statement,
            current_setting('log_statement',             true) AS log_statement,
            current_setting('log_lock_waits',            true) AS log_lock_waits,
            current_setting('log_temp_files',            true) AS log_temp_files,
            current_setting('log_checkpoints',           true) AS log_checkpoints
        `);
        settingsRow = settingsResult.rows[0] ?? {};
      } catch (error) {
        sourceNotes.push(
          `Could not read PostgreSQL logging settings (${getErrorMessage(error)}).`,
        );
      }

      const settings = {
        loggingCollector: toString(settingsRow['logging_collector']),
        logDestination: toString(settingsRow['log_destination']),
        logDirectory: toString(settingsRow['log_directory']),
        logFilename: toString(settingsRow['log_filename']),
        logLinePrefix: toString(settingsRow['log_line_prefix']),
        logMinDurationStatement: toString(
          settingsRow['log_min_duration_statement'],
        ),
        logStatement: toString(settingsRow['log_statement']),
        logLockWaits: toString(settingsRow['log_lock_waits']),
        logTempFiles: toString(settingsRow['log_temp_files']),
        logCheckpoints: toString(settingsRow['log_checkpoints']),
      };

      // Detect JSON log destination (PostgreSQL 15+)
      const logDest = (settings.logDestination ?? '').toLowerCase();
      const isJsonLog = logDest.includes('jsonlog');
      if (isJsonLog) {
        sourceNotes.push(
          'log_destination includes jsonlog — attempting to read structured JSON log file.',
        );
      }

      // Warn when logging_collector is off
      if ((settings.loggingCollector ?? '').startsWith('off')) {
        sourceNotes.push(
          'logging_collector is off; logs are written to stderr and file-based log introspection is unavailable. Consider enabling logging_collector or configuring a syslog/csvlog destination.',
        );
      }

      // Warn when slow statement logging is not configured
      const logMinDuration = toNumber(settings.logMinDurationStatement);
      if (logMinDuration === null || logMinDuration < 0) {
        sourceNotes.push(
          'log_min_duration_statement is not set or disabled — slow queries will not appear in logs. Set it to a positive value (e.g. 500) to capture slow statements.',
        );
      }

      // ------------------------------------------------------------------
      // 2. Resolve current log file path
      //    For jsonlog destinations the file has a .json extension.
      // ------------------------------------------------------------------
      let currentLogPath: string | null = null;

      // Try the standard function first
      try {
        const logPathResult = await query(
          'SELECT pg_current_logfile() AS log_path',
        );
        currentLogPath = toString(logPathResult.rows[0]?.['log_path']);
      } catch (error) {
        sourceNotes.push(
          `Could not resolve current log file path via pg_current_logfile() (${getErrorMessage(error)}).`,
        );
      }

      // For jsonlog: if we got a .log path, also try the .json variant
      if (currentLogPath && !currentLogPath.endsWith('.json') && isJsonLog) {
        const jsonPath = currentLogPath.replace(/\.\w+$/, '') + '.json';
        try {
          await query(
            `SELECT (pg_stat_file('${jsonPath.replace(/'/g, "''")}', true)).size`,
          );
          currentLogPath = jsonPath;
          sourceNotes.push(`Switched to JSON log file path: ${jsonPath}`);
        } catch {
          // JSON file not accessible — stay with original path
        }
      }

      // ------------------------------------------------------------------
      // 3. Read tail of log file via pg_read_file
      //    Requires pg_read_all_settings privilege or superuser.
      // ------------------------------------------------------------------
      let fileSizeBytes: number | null = null;
      let bytesRead = 0;
      let parsedSignals: ParsedPostgresLogSignals = {
        linesScanned: 0,
        formatDetected: null,
        counts: {
          slowStatements: 0,
          errors: 0,
          warnings: 0,
          lockWaits: 0,
          tempFiles: 0,
          checkpoints: 0,
          autovacuumEvents: 0,
        },
        slowStatements: [],
        errors: [],
        lockWaitEvents: [],
        tempFileEvents: [],
        checkpointEvents: [],
        autovacuumEvents: [],
      };

      if (currentLogPath && currentLogPath.trim() !== '') {
        const escapedLogPath = currentLogPath.replace(/'/g, "''");

        try {
          const statResult = await query(`
            SELECT (pg_stat_file('${escapedLogPath}', true)).size AS file_size
          `);
          fileSizeBytes = toNumber(statResult.rows[0]?.['file_size']);
        } catch (error) {
          sourceNotes.push(
            `Unable to stat log file via pg_stat_file (${getErrorMessage(error)}). This is common on managed services (RDS, Cloud SQL, Azure Database) that restrict file system access.`,
          );
        }

        if (fileSizeBytes !== null) {
          const startOffset = Math.max((fileSizeBytes ?? 0) - tailBytes, 0);

          try {
            const contentResult = await query(`
              SELECT pg_read_file('${escapedLogPath}', ${startOffset}, ${tailBytes}, true) AS content
            `);

            const content = toString(contentResult.rows[0]?.['content']) ?? '';
            bytesRead = content.length;

            if (content.trim() === '') {
              sourceNotes.push(
                'Log file returned no content for the requested tail window — the file may be empty or the offset is beyond the current write position.',
              );
            } else {
              parsedSignals = extractPostgresLogSignals(content, maxEvents);

              if (
                parsedSignals.linesScanned > 0 &&
                parsedSignals.formatDetected === null
              ) {
                sourceNotes.push(
                  `Log file was read (${parsedSignals.linesScanned} lines) but no known log_line_prefix format was detected. Log line prefix may be highly customised. Raw lines were still scanned for pattern matches.`,
                );
              }
            }
          } catch (error) {
            sourceNotes.push(
              `Unable to read log file via pg_read_file (${getErrorMessage(error)}). On managed PostgreSQL services (RDS, Cloud SQL, Azure Database for PostgreSQL, Supabase) direct file access is typically restricted — use cloud-native logging dashboards for log analysis.`,
            );
          }
        }
      } else {
        sourceNotes.push(
          'pg_current_logfile() returned null or empty. This commonly means logging_collector=off and logs are routed to stderr or an external log aggregator.',
        );
      }

      // ------------------------------------------------------------------
      // 4. Surface actionable configuration observations
      // ------------------------------------------------------------------
      if (!settings.logLockWaits || settings.logLockWaits === 'off') {
        sourceNotes.push(
          'log_lock_waits is off — lock wait events will not appear in logs even if locks are occurring.',
        );
      }
      if (
        settings.logTempFiles !== null &&
        toNumber(settings.logTempFiles) === -1
      ) {
        sourceNotes.push(
          'log_temp_files=-1 means temp file logging is disabled — spill events will not be captured in logs.',
        );
      }

      return {
        capturedAt: new Date().toISOString(),
        datasourceId: datasource.id,
        tailBytes,
        maxEvents,
        settings,
        currentLogPath,
        fileSizeBytes,
        bytesRead,
        linesScanned: parsedSignals.linesScanned,
        formatDetected: parsedSignals.formatDetected,
        counts: parsedSignals.counts,
        slowStatements: parsedSignals.slowStatements,
        errors: parsedSignals.errors,
        lockWaitEvents: parsedSignals.lockWaitEvents,
        tempFileEvents: parsedSignals.tempFileEvents,
        checkpointEvents: parsedSignals.checkpointEvents,
        autovacuumEvents: parsedSignals.autovacuumEvents,
        sourceNotes,
      };
    });
  },
});
