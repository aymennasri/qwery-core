import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { __testables } from '../../src/tools/validate-remediation-in-gfs-cli';

function makeExplainJson(input: {
  planningTimeMs: number;
  executionTimeMs: number;
  nodeType: string;
  relationName?: string;
  indexName?: string;
  planRows?: number;
  actualRows?: number;
  sharedHitBlocks?: number;
  sharedReadBlocks?: number;
}) {
  return JSON.stringify([
    {
      'Planning Time': input.planningTimeMs,
      'Execution Time': input.executionTimeMs,
      Plan: {
        'Node Type': input.nodeType,
        ...(input.relationName ? { 'Relation Name': input.relationName } : {}),
        ...(input.indexName ? { 'Index Name': input.indexName } : {}),
        ...(input.planRows !== undefined ? { 'Plan Rows': input.planRows } : {}),
        ...(input.actualRows !== undefined
          ? { 'Actual Rows': input.actualRows }
          : {}),
        ...(input.sharedHitBlocks !== undefined
          ? { 'Shared Hit Blocks': input.sharedHitBlocks }
          : {}),
        ...(input.sharedReadBlocks !== undefined
          ? { 'Shared Read Blocks': input.sharedReadBlocks }
          : {}),
      },
    },
  ]);
}

describe('validate_remediation_in_gfs_cli helpers', () => {
  it('parses PostgreSQL major versions from client banners', () => {
    expect(
      __testables.parsePostgresClientMajorVersion('pg_dump (PostgreSQL) 18.1'),
    ).toBe('18');
    expect(
      __testables.parsePostgresClientMajorVersion(
        'psql (PostgreSQL) 16.8 (Debian 16.8-1.pgdg120+1)',
      ),
    ).toBe('16');
  });

  it('parses abbreviated commit hashes from gfs log output', () => {
    expect(
      __testables.parseCommitHash(
        'commit fe7c2f7 (HEAD -> main, main)\nAuthor: test <test@example.com>',
      ),
    ).toBe('fe7c2f7');
  });

  it('builds version-aware binary candidates before generic fallbacks', () => {
    expect(__testables.buildVersionedBinaryCandidates('pg_dump', '16')).toEqual(
      [
        'pg_dump-16',
        'pg_dump16',
        '/usr/lib/postgresql/16/bin/pg_dump',
        '/usr/pgsql-16/bin/pg_dump',
        '/opt/homebrew/opt/libpq@16/bin/pg_dump',
        '/usr/local/opt/libpq@16/bin/pg_dump',
      ],
    );
  });

  it('includes generic and versioned bootstrap candidates', () => {
    const candidates = __testables.buildBootstrapBinaryCandidates('psql');

    expect(candidates[0]).toBe('psql');
    expect(candidates).toContain('/usr/bin/psql');
    expect(candidates).toContain('/usr/lib/postgresql/16/bin/psql');
    expect(candidates).toContain('/usr/pgsql-16/bin/psql');
  });

  it('uses QWERY_GFS_AUDITS_DIR when set', () => {
    const original = process.env.QWERY_GFS_AUDITS_DIR;
    process.env.QWERY_GFS_AUDITS_DIR = '/var/tmp/custom-gfs-audits';

    try {
      expect(__testables.resolveGfsAuditWorkingRoot()).toBe(
        '/var/tmp/custom-gfs-audits',
      );
    } finally {
      if (original === undefined) {
        delete process.env.QWERY_GFS_AUDITS_DIR;
      } else {
        process.env.QWERY_GFS_AUDITS_DIR = original;
      }
    }
  });

  it('builds a stable baseline cache key', () => {
    expect(
      __testables.buildBaselineCacheKey({
        conversationId: 'conversation-a',
        datasourceId: 'datasource-1',
        connectionUrl: 'postgres://user:pass@db.example.com:5432/app',
      }),
    ).toBe(
      __testables.buildBaselineCacheKey({
        conversationId: 'conversation-a',
        datasourceId: 'datasource-1',
        connectionUrl: 'postgres://user:pass@db.example.com:5432/app',
      }),
    );
    expect(
      __testables.buildBaselineCacheKey({
        conversationId: 'conversation-a',
        datasourceId: 'datasource-1',
        connectionUrl: 'postgres://user:pass@db.example.com:5432/app',
      }),
    ).not.toBe(
      __testables.buildBaselineCacheKey({
        conversationId: 'conversation-b',
        datasourceId: 'datasource-1',
        connectionUrl: 'postgres://user:pass@db.example.com:5432/app',
      }),
    );
  });

  it('appends branch suffixes within the branch length limit', () => {
    const branchName = __testables.buildBranchNameWithSuffix(
      'audit-this-branch-name-is-intentionally-long-to-exercise-trimming',
      '12345678',
    );

    expect(branchName).toMatch(/-12345678$/);
    expect(branchName.length).toBeLessThanOrEqual(63);
  });

  it('treats startup and connection-refused errors as retryable', () => {
    expect(
      __testables.isRetryablePostgresStartupError(
        new Error(
          'psql command failed: psql: error: connection to server at "localhost" (::1), port 42211 failed: FATAL:  the database system is starting up',
        ),
      ),
    ).toBe(true);
    expect(
      __testables.isRetryablePostgresStartupError(
        new Error(
          'psql command failed: psql: error: connection to server at "localhost" (::1), port 42211 failed: Connection refused',
        ),
      ),
    ).toBe(true);
    expect(
      __testables.isRetryablePostgresStartupError(
        new Error(
          'gfs command failed: error: import failed: import task failed (exit 2): psql: error: connection to server at "10.88.0.4", port 5432 failed: Connection refused\n\tIs the server running on that host and accepting TCP/IP connections?',
        ),
      ),
    ).toBe(true);
    expect(
      __testables.isRetryablePostgresStartupError(
        new Error(
          'psql command failed: psql: error: connection to server at "localhost" (::1), port 37099 failed: server closed the connection unexpectedly\n\tThis probably means the server terminated abnormally\n\tbefore or while processing the request.',
        ),
      ),
    ).toBe(true);
  });

  it('does not hide non-startup psql failures as retryable', () => {
    expect(
      __testables.isRetryablePostgresStartupError(
        new Error(
          'psql command failed: psql: error: relation "missing_table" does not exist',
        ),
      ),
    ).toBe(false);
  });

  it('partitions session-scoped and persistent action statements', () => {
    expect(
      __testables.partitionActionStatements([
        "SET work_mem = '256MB'",
        'ANALYZE orders',
        'CREATE INDEX idx_orders_status ON orders (status)',
        'RESET work_mem',
      ]),
    ).toEqual({
      persistentStatements: [
        'ANALYZE orders',
        'CREATE INDEX idx_orders_status ON orders (status)',
      ],
      sessionSetupStatements: ["SET work_mem = '256MB'"],
      sessionTeardownStatements: ['RESET work_mem'],
    });
  });

  it('builds a single-session benchmark script for SET LOCAL experiments', () => {
    expect(
      __testables.buildSessionScopedExplainSql({
        validationQuery: 'SELECT * FROM orders WHERE status = $1',
        sessionSetupStatements: ["SET LOCAL work_mem = '256MB'"],
        sessionTeardownStatements: ['RESET work_mem'],
      }),
    ).toBe(
      [
        'BEGIN',
        "SET LOCAL work_mem = '256MB'",
        'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM orders WHERE status = $1',
        'RESET work_mem',
        'COMMIT',
      ].join(';\n'),
    );
  });

  it('extracts EXPLAIN JSON from session-scoped psql output', () => {
    const json = '[{"Plan":{"Node Type":"Aggregate"},"Planning Time":0.1,"Execution Time":1.2}]';

    expect(
      __testables.extractExplainJsonPayload(
        ['BEGIN', 'SET', json, 'RESET', 'COMMIT'].join('\n'),
      ),
    ).toBe(json);
  });

  it('fails fast when another validation already holds the baseline lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gfs-lock-'));
    const lockDir = join(root, 'baseline.lock');
    const signal = new AbortController().signal;

    let releaseLock: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    const first = __testables.withDirectoryLock(lockDir, signal, async () => {
      await lockHeld;
      return 'done';
    });

    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await stat(lockDir);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    await expect(
      __testables.withDirectoryLock(
        lockDir,
        signal,
        async () => 'unreachable',
        {
          waitOnBusy: false,
          busyMessage: 'busy lock',
        },
      ),
    ).rejects.toThrow('busy lock');

    releaseLock?.();
    await expect(first).resolves.toBe('done');
    await rm(root, { recursive: true, force: true });
  });

  it('parses root plan details from EXPLAIN JSON output', () => {
    expect(
      __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1.5,
          executionTimeMs: 9.25,
          nodeType: 'Index Scan',
          relationName: 'orders',
          indexName: 'idx_orders_status_region',
          planRows: 100,
          actualRows: 100,
          sharedHitBlocks: 18,
          sharedReadBlocks: 2,
        }),
      ),
    ).toEqual({
      rootNodeType: 'Index Scan',
      relationName: 'orders',
      indexName: 'idx_orders_status_region',
      planRows: 100,
      actualRows: 100,
      sharedHitBlocks: 18,
      sharedReadBlocks: 2,
    });
  });

  it('marks regressed representative benchmarks as rejected', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 9,
          nodeType: 'Seq Scan',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 9,
          nodeType: 'Seq Scan',
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 29,
          nodeType: 'Index Scan',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 29,
          nodeType: 'Index Scan',
        }),
      ),
    };

    expect(__testables.assessValidationResult(before, after)).toMatchObject({
      timingOutcome: 'regressed',
      recommendationStatus: 'rejected',
      benchmarkSuitability: 'latency-impact',
    });
  });

  it('flags sub-5ms benchmarks as low-latency even when they improve', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 2,
          nodeType: 'Seq Scan',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 2,
          nodeType: 'Seq Scan',
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 0.5,
          executionTimeMs: 0.5,
          nodeType: 'Seq Scan',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 0.5,
          executionTimeMs: 0.5,
          nodeType: 'Seq Scan',
        }),
      ),
    };

    expect(__testables.assessValidationResult(before, after)).toMatchObject({
      timingOutcome: 'improved',
      recommendationStatus: 'validated',
      benchmarkSuitability: 'low-latency',
    });
  });
});
