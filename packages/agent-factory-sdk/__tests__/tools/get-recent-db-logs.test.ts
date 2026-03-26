import { describe, expect, it } from 'vitest';
import { extractPostgresLogSignals } from '../../src/tools/get-recent-db-logs';

describe('get_recent_db_logs parser', () => {
  it('extracts slow statements, errors, lock waits, temp files, and checkpoints', () => {
    const logContent = [
      '2026-03-03 09:39:56.884 UTC [549] LOG:  duration: 4718.964 ms  statement: SELECT COUNT(*) FROM employees.salary',
      '2026-03-03 09:40:00.362 UTC [551] ERROR:  relation "title_basics" does not exist at character 114',
      '2026-03-03 09:40:00.362 UTC [551] STATEMENT:  SELECT * FROM title_basics',
      '2026-03-03 09:40:07.000 UTC [560] LOG:  process 560 still waiting for ShareLock on transaction 123 after 1000.000 ms',
      '2026-03-03 09:40:12.000 UTC [561] LOG:  temporary file: path "base/pgsql_tmp/pgsql_tmp561.0", size 204800',
      '2026-03-03 09:42:43.264 UTC [22] LOG:  checkpoint starting: time',
    ].join('\n');

    const parsed = extractPostgresLogSignals(logContent, 10);

    expect(parsed.linesScanned).toBe(6);
    expect(parsed.counts.slowStatements).toBe(1);
    expect(parsed.counts.errors).toBe(1);
    expect(parsed.counts.lockWaits).toBe(1);
    expect(parsed.counts.tempFiles).toBe(1);
    expect(parsed.counts.checkpoints).toBe(1);
    expect(parsed.slowStatements[0]?.durationMs).toBeCloseTo(4718.964, 3);
    expect(parsed.errors[0]?.statement).toContain('SELECT * FROM title_basics');
    expect(parsed.tempFileEvents[0]?.sizeBytes).toBe(204800);
  });

  it('limits returned samples per category while keeping full counts', () => {
    const logContent = [
      '2026-03-03 09:00:00.000 UTC [101] LOG:  duration: 1000.000 ms  statement: SELECT 1',
      '2026-03-03 09:00:01.000 UTC [102] LOG:  duration: 1100.000 ms  statement: SELECT 2',
      '2026-03-03 09:00:02.000 UTC [103] LOG:  duration: 1200.000 ms  statement: SELECT 3',
    ].join('\n');

    const parsed = extractPostgresLogSignals(logContent, 2);

    expect(parsed.counts.slowStatements).toBe(3);
    expect(parsed.slowStatements).toHaveLength(2);
  });
});
