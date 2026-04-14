import { describe, expect, it } from 'vitest';
import { buildAuditReport } from '../../src/tools/db-audit/report-builder';

describe('buildAuditReport', () => {
  it('builds top latency findings from plan insights', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_123',
      database: 'app',
      planInsights: [
        {
          query: 'SELECT * FROM orders WHERE customer_id = 42',
          executionTimeMs: 3250,
          planningTimeMs: 3.2,
          seqScanNodes: 1,
          indexScanNodes: 0,
          planRows: 100,
          actualRows: 12000,
        },
      ],
      slowQueries: [
        {
          query: 'SELECT * FROM orders WHERE customer_id = 42',
          meanExecTimeMs: 3250,
          source: 'pg_stat_activity',
        },
      ],
    });

    expect(report.engine).toBe('postgresql');
    expect(report.scope.datasourceId).toBe('ds_123');
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings[0]?.category).toBe('query-plan');
    expect(report.findings[0]?.evidence.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.toLowerCase()).toContain('latency-impact');
    expect(report.crossLayerSignals).toEqual([]);
    expect(report.auditTasks.length).toBeGreaterThan(0);
  });

  it('combines query and infra signals into cross-layer observations', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_456',
      database: 'employees',
      planInsights: [
        {
          query:
            'SELECT employee_id, SUM(amount) FROM salary GROUP BY employee_id',
          executionTimeMs: 2840,
          planningTimeMs: 4.1,
          seqScanNodes: 1,
          indexScanNodes: 0,
          planRows: 10000,
          actualRows: 2800000,
        },
      ],
      infraSignals: {
        os: {
          uptimeSeconds: 12800,
          dataDirectory: '/var/lib/postgresql/data',
        },
        connection: {
          maxConnections: 200,
          totalSessions: 168,
          activeSessions: 32,
          waitingActiveSessions: 9,
          utilizationPct: 84,
        },
        cpu: {
          runningActiveSessions: 23,
          waitingActiveSessions: 9,
          maxWorkerProcesses: 8,
          maxParallelWorkers: 8,
          maxParallelWorkersPerGather: 2,
          jit: 'on',
        },
        network: {
          networkWaitSessions: 7,
          clientReadWaitSessions: 5,
          clientWriteWaitSessions: 2,
          tcpKeepalivesIdle: '7200 s',
          tcpKeepalivesInterval: '75 s',
          tcpKeepalivesCount: '9',
        },
        waits: {
          lockWaitSessions: 3,
          ioWaitSessions: 5,
          networkWaitSessions: 7,
        },
        io: {
          cacheHitPct: 91.4,
          tempBytes: 536870912,
        },
        config: {
          workMem: '104 MB',
          trackIoTiming: 'off',
        },
        logging: {
          loggingCollector: 'on',
          logMinDurationStatement: '250 ms',
        },
      },
    });

    expect(report.crossLayerSignals.length).toBeGreaterThan(0);
    expect(report.summary).toContain('Cross-layer context');
    expect(
      report.findings[0]?.evidence.some((line) =>
        line.startsWith('Infra metric:'),
      ),
    ).toBe(true);
    expect(
      report.auditTasks.some(
        (task) =>
          task.id === 'collect_logging_metadata' && task.status === 'completed',
      ),
    ).toBe(true);
  });

  it('returns no findings when strict evidence is missing', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_123',
      planInsights: [],
    });

    expect(report.findings).toHaveLength(0);
    expect(report.quickWins).toEqual([]);
    expect(report.nextSteps).toEqual([]);
  });

  it('ignores low-latency metadata plan insights', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_meta',
      planInsights: [
        {
          query:
            'SELECT table_schema, table_name FROM information_schema.tables',
          executionTimeMs: 1.19,
          planningTimeMs: 2.7,
          seqScanNodes: 4,
          indexScanNodes: 0,
          planRows: 30,
          actualRows: 8,
        },
      ],
    });

    expect(report.findings).toHaveLength(0);
    expect(report.summary).toContain('No latency-impact findings');
  });

  it('ranks lock, bloat, duplicate-index, and unused-index findings by severity and confidence', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_ops',
      planInsights: [],
      lockSignals: {
        blockingChainCount: 4,
        idleInTransactionCount: 2,
        deadlockCount: 1,
        lockWaitSessions: 3,
      },
      tableHealth: [
        {
          schema: 'public',
          table: 'orders',
          totalSizeBytes: 512 * 1024 * 1024,
          deadTuplePct: 31,
          seqScan: 120,
          idxScan: 80,
          liveTuples: 2_000_000,
          modSinceAnalyze: 400_000,
          secondsSinceVacuum: 8 * 24 * 3600,
          secondsSinceAnalyze: 3 * 24 * 3600,
          autovacuumEnabledOverride: 'on',
          lastVacuum: '2026-03-01T00:00:00Z',
          lastAutovacuum: '2026-03-01T00:00:00Z',
        },
      ],
      indexHealth: {
        duplicateIndexes: [
          {
            schema: 'public',
            table: 'orders',
            indexSignature: '(customer_id)',
            indexNames: [
              'idx_orders_customer_id',
              'idx_orders_customer_id_dup',
            ],
            duplicateCount: 2,
            totalSizeBytes: 96 * 1024 * 1024,
          },
        ],
        unusedIndexes: [
          {
            schema: 'public',
            table: 'orders',
            index: 'idx_orders_legacy_status',
            sizeBytes: 128 * 1024 * 1024,
            dropCandidate: true,
            isPrimary: false,
            isUnique: false,
            backsConstraint: false,
          },
        ],
      },
    });

    expect(report.findings.map((finding) => finding.category)).toEqual([
      'locks-waits',
      'table-stats',
      'indexing',
      'indexing',
    ]);
    expect(report.findings[0]?.severity).toBe('high');
    expect(report.findings[1]?.severity).toBe('high');
    expect(report.findings[2]?.title).toContain('Duplicate index group');
    expect(report.findings[3]?.title).toContain('Unused index');
  });

  it('creates configuration findings only for actual gaps and suppresses synthetic remediation SQL', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_cfg',
      planInsights: [],
      configGaps: {
        trackIoTiming: 'off',
        logMinDurationStatement: '-1',
        pgStatStatementsEnabled: false,
      },
    });

    expect(report.findings).toHaveLength(3);
    expect(report.findings.map((finding) => finding.severity)).toEqual([
      'high',
      'medium',
      'low',
    ]);
    expect(report.findings[0]?.title).toContain('pg_stat_statements');
    expect(report.findings[1]?.recommendation).toContain(
      'executed GFS validations',
    );
    expect(report.findings[1]?.sql).toBeUndefined();
    expect(report.findings[2]?.sql).toBeUndefined();
    expect(report.incompleteReason).toBe(
      'Audit incomplete: not all solutions could be executed in GFS.',
    );
  });

  it('keeps missing operational data as not-collected or partial task coverage', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_partial',
      planInsights: [],
      infraSignals: {
        connection: {
          maxConnections: 100,
          activeSessions: 4,
          utilizationPct: 4,
        },
      },
    });

    const osTask = report.auditTasks.find(
      (task) => task.id === 'collect_os_metadata',
    );
    const cpuTask = report.auditTasks.find(
      (task) => task.id === 'collect_cpu_signals',
    );
    const configTask = report.auditTasks.find(
      (task) => task.id === 'collect_config_metadata',
    );

    expect(osTask?.status).toBe('partial');
    expect(cpuTask?.status).toBe('partial');
    expect(configTask?.status).toBe('partial');
    expect(report.findings).toHaveLength(0);
  });

  it('surfaces only validated GFS actions as quick wins and next steps', () => {
    const report = buildAuditReport({
      engine: 'postgresql',
      datasourceId: 'ds_validated',
      planInsights: [
        {
          query: 'SELECT * FROM orders WHERE customer_id = 42',
          executionTimeMs: 3250,
          planningTimeMs: 3.2,
          seqScanNodes: 1,
          indexScanNodes: 0,
          planRows: 100,
          actualRows: 12000,
        },
      ],
      gfsValidations: [
        {
          recommendation: 'ANALYZE public.orders',
          validationType: 'maintenance',
          branchName: 'audit-branch',
          checkpointCommit: 'abc123',
          afterCommit: 'def456',
          actionTaken: 'ANALYZE public.orders',
          beforeTimeMs: 300,
          afterTimeMs: 200,
          beforeReadBlocks: 100,
          afterReadBlocks: 80,
          beforeHitBlocks: 50,
          afterHitBlocks: 60,
          deltaMs: -100,
          deltaPct: -33.3,
          recommendationStatus: 'validated',
          benchmarkSuitability: 'latency-impact',
          rollback: 'not needed',
        },
      ],
    });

    expect(report.quickWins).toEqual([
      'Validated in GFS: ANALYZE public.orders',
    ]);
    expect(report.nextSteps).toEqual([
      'Use the validated GFS evidence for analyze public.orders before any rollout decision.',
    ]);
    expect(report.incompleteReason).toBeUndefined();
  });
});
