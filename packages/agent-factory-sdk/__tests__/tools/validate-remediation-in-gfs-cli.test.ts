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
        ...(input.planRows !== undefined
          ? { 'Plan Rows': input.planRows }
          : {}),
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
  it('builds conversation-scoped repo keys', () => {
    expect(
      __testables.buildGfsConversationRepoKey({
        conversationId: '5a11a99c-fe25-4d7c-8e8a-12fe765e378e',
        datasourceId: '1dd61efe-65b1-438d-bbed-c6a7d96a53ca',
      }),
    ).toBe(
      '5a11a99c-fe25-4d7c-8e8a-12fe765e378e-1dd61efe-65b1-438d-bbed-c6a7d96a53ca',
    );
  });

  it('parses abbreviated commit hashes from gfs log output', () => {
    expect(
      __testables.parseCommitHash(
        'commit fe7c2f7 (HEAD -> main, main)\nAuthor: test <test@example.com>',
      ),
    ).toBe('fe7c2f7');
  });

  it('serializes concurrent GFS validation work', async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = __testables.runGfsValidationExclusive(async () => {
      events.push('first-start');
      await firstCanFinish;
      events.push('first-end');
      return 'first';
    });
    const second = __testables.runGfsValidationExclusive(async () => {
      events.push('second-start');
      events.push('second-end');
      return 'second';
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events).toEqual(['first-start']);

    releaseFirst?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      'first',
      'second',
    ]);
    expect(events).toEqual([
      'first-start',
      'first-end',
      'second-start',
      'second-end',
    ]);
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

  it('extracts config setting names from SET and RESET statements', () => {
    expect(
      __testables.extractConfiguredSettingName("SET LOCAL work_mem = '256MB'"),
    ).toBe('work_mem');
    expect(
      __testables.extractConfiguredSettingName('RESET random_page_cost'),
    ).toBe('random_page_cost');
  });

  it('rejects restart-only settings in config validations', () => {
    expect(() =>
      __testables.validateConfigActionStatements({
        persistentStatements: [],
        sessionSetupStatements: ["SET LOCAL shared_buffers = '8GB'"],
        sessionTeardownStatements: ['RESET shared_buffers'],
      }),
    ).toThrow(/SQL-runtime-settable settings/);
  });

  it('accepts session-settable config validations', () => {
    expect(() =>
      __testables.validateConfigActionStatements({
        persistentStatements: [],
        sessionSetupStatements: ['SET LOCAL random_page_cost = 1.1'],
        sessionTeardownStatements: ['RESET random_page_cost'],
      }),
    ).not.toThrow();
  });

  it('extracts EXPLAIN JSON from session-scoped psql output', () => {
    const json =
      '[{"Plan":{"Node Type":"Aggregate"},"Planning Time":0.1,"Execution Time":1.2}]';

    expect(
      __testables.extractExplainJsonPayload(
        ['BEGIN', 'SET', json, 'RESET', 'COMMIT'].join('\n'),
      ),
    ).toBe(json);
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
      accessPathSignature: 'Index Scan:orders:idx_orders_status_region',
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

  it('treats high-residual partial latency improvements as inconclusive', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 5,
          executionTimeMs: 8224,
          nodeType: 'Limit',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 5,
          executionTimeMs: 8224,
          nodeType: 'Limit',
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 5687,
          nodeType: 'Limit',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 5687,
          nodeType: 'Limit',
        }),
      ),
    };

    expect(__testables.assessValidationResult(before, after)).toMatchObject({
      timingOutcome: 'improved',
      recommendationStatus: 'inconclusive',
      benchmarkSuitability: 'latency-impact',
    });
  });

  it('does not validate index changes on timing-only improvement', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 3,
          executionTimeMs: 9939,
          nodeType: 'Limit',
          sharedReadBlocks: 50_471,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 3,
          executionTimeMs: 9939,
          nodeType: 'Limit',
          sharedReadBlocks: 50_471,
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 873,
          nodeType: 'Limit',
          sharedReadBlocks: 50_449,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 873,
          nodeType: 'Limit',
          sharedReadBlocks: 50_449,
        }),
      ),
    };

    expect(
      __testables.assessValidationResult(before, after, 'latency', [
        'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_orders_status ON orders (status)',
      ]),
    ).toMatchObject({
      timingOutcome: 'improved',
      recommendationStatus: 'inconclusive',
      benchmarkSuitability: 'latency-impact',
    });
  });

  it('validates index changes when access path changes', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 3,
          executionTimeMs: 100,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 10_000,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 3,
          executionTimeMs: 100,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 10_000,
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 10,
          nodeType: 'Index Scan',
          indexName: 'idx_orders_status',
          sharedReadBlocks: 9_900,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 10,
          nodeType: 'Index Scan',
          indexName: 'idx_orders_status',
          sharedReadBlocks: 9_900,
        }),
      ),
    };

    expect(
      __testables.assessValidationResult(before, after, 'latency', [
        'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)',
      ]),
    ).toMatchObject({
      timingOutcome: 'improved',
      recommendationStatus: 'validated',
      benchmarkSuitability: 'latency-impact',
    });
  });

  it('does not validate config changes from timing-only noise', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 100_000,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 100_000,
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 80,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 99_950,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 80,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 99_950,
        }),
      ),
    };

    expect(
      __testables.assessValidationResult(before, after, 'config'),
    ).toMatchObject({
      timingOutcome: 'improved',
      recommendationStatus: 'inconclusive',
      benchmarkSuitability: 'latency-impact',
    });
  });

  it('validates config changes with material read-block improvement', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 100_000,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 100_000,
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 80,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 50_000,
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 1,
          executionTimeMs: 80,
          nodeType: 'Seq Scan',
          sharedReadBlocks: 50_000,
        }),
      ),
    };

    expect(
      __testables.assessValidationResult(before, after, 'config'),
    ).toMatchObject({
      timingOutcome: 'improved',
      recommendationStatus: 'validated',
      benchmarkSuitability: 'latency-impact',
    });
  });

  it('validates maintenance changes that do not regress the benchmark', () => {
    const before = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
        }),
      ),
    };
    const after = {
      ...__testables.parseExplainMetrics(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
        }),
      ),
      plan: __testables.parseExplainPlanSummary(
        makeExplainJson({
          planningTimeMs: 2,
          executionTimeMs: 98,
          nodeType: 'Seq Scan',
        }),
      ),
    };

    expect(
      __testables.assessValidationResult(before, after, 'maintenance'),
    ).toMatchObject({
      timingOutcome: 'neutral',
      recommendationStatus: 'validated',
      benchmarkSuitability: 'latency-impact',
    });
  });
});
