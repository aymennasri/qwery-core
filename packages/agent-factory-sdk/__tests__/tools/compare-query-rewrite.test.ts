import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDriverInstanceMock, extensionsRegistryGetMock } = vi.hoisted(() => ({
  getDriverInstanceMock: vi.fn(),
  extensionsRegistryGetMock: vi.fn(),
}));

vi.mock('@qwery/extensions-loader', () => ({
  getDriverInstance: getDriverInstanceMock,
}));

vi.mock('@qwery/extensions-sdk', () => ({
  ExtensionsRegistry: {
    get: extensionsRegistryGetMock,
  },
}));

import { CompareQueryRewriteTool } from '../../src/tools/compare-query-rewrite';

function createContext() {
  const findById = vi.fn().mockResolvedValue({
    id: 'ds1',
    datasource_provider: 'postgres',
    config: { connectionUrl: 'postgresql://db' },
    name: 'postgres-air',
  });

  return {
    conversationId: 'conversation-1',
    agentId: 'slow-query-optimizer',
    abort: new AbortController().signal,
    messages: [],
    ask: async () => undefined,
    metadata: async () => undefined,
    extra: {
      repositories: {
        datasource: {
          findById,
        },
      },
      attachedDatasources: ['ds1'],
    },
  };
}

function explainRow(input: {
  executionTimeMs: number;
  relation: string;
}): Record<string, unknown> {
  return {
    'QUERY PLAN': [
      {
        'Planning Time': 1,
        'Execution Time': input.executionTimeMs,
        Plan: {
          'Node Type': 'Seq Scan',
          'Relation Name': input.relation,
          'Plan Rows': 10,
          'Actual Rows': 10,
          'Shared Hit Blocks': 10,
          'Shared Read Blocks': 20,
          'Temp Read Blocks': 0,
          'Temp Written Blocks': 0,
        },
      },
    ],
  };
}

function createDriverQueryMock(input: {
  samePlanShape?: boolean;
  slow?: boolean;
}) {
  const sqlCalls: string[] = [];
  const queryMock = vi.fn(async (sql: string) => {
    sqlCalls.push(sql);

    if (sql.startsWith('EXPLAIN')) {
      const isOriginal = sql.includes('original_table');
      const relation = input.samePlanShape
        ? 'shared_relation'
        : isOriginal
          ? 'original_relation'
          : 'rewritten_relation';
      const executionTimeMs = input.slow
        ? isOriginal
          ? 20_000
          : 18_000
        : isOriginal
          ? 50
          : 40;

      return {
        columns: ['QUERY PLAN'],
        rows: [
          explainRow({
            executionTimeMs,
            relation,
          }),
        ],
      };
    }

    return {
      columns: ['value'],
      rows: [{ value: 1 }],
    };
  });

  return { queryMock, sqlCalls };
}

describe('CompareQueryRewriteTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extensionsRegistryGetMock.mockReturnValue({
      drivers: [{ runtime: 'node' }],
    });
  });

  it('alternates execution order across benchmark runs', async () => {
    const { queryMock, sqlCalls } = createDriverQueryMock({
      samePlanShape: false,
    });
    const close = vi.fn(async () => undefined);
    getDriverInstanceMock.mockResolvedValue({ query: queryMock, close });

    if (
      !('execute' in CompareQueryRewriteTool) ||
      typeof CompareQueryRewriteTool.execute !== 'function'
    ) {
      throw new Error('CompareQueryRewriteTool does not expose execute.');
    }

    const result = await CompareQueryRewriteTool.execute(
      {
        originalQuery: 'SELECT * FROM original_table',
        rewrittenQuery: 'SELECT * FROM rewritten_table',
        runs: 4,
        checkEquivalence: false,
      },
      createContext(),
    );

    expect(result).toMatchObject({
      completedRuns: 4,
      executionOrderByRun: [
        ['original', 'rewritten'],
        ['rewritten', 'original'],
        ['original', 'rewritten'],
        ['rewritten', 'original'],
      ],
    });

    expect(sqlCalls.slice(0, 8)).toEqual([
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM original_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM rewritten_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM rewritten_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM original_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM original_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM rewritten_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM rewritten_table',
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT * FROM original_table',
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('marks confidence low when equivalence is skipped and plan shape is unchanged', async () => {
    const { queryMock } = createDriverQueryMock({
      samePlanShape: true,
      slow: true,
    });
    getDriverInstanceMock.mockResolvedValue({
      query: queryMock,
      close: vi.fn(async () => undefined),
    });

    if (
      !('execute' in CompareQueryRewriteTool) ||
      typeof CompareQueryRewriteTool.execute !== 'function'
    ) {
      throw new Error('CompareQueryRewriteTool does not expose execute.');
    }

    const result = await CompareQueryRewriteTool.execute(
      {
        originalQuery: 'SELECT * FROM original_table',
        rewrittenQuery: 'SELECT * FROM rewritten_table',
        runs: 3,
        checkEquivalence: true,
      },
      createContext(),
    );

    expect(result).toMatchObject({
      delta: {
        planShapeChanged: false,
      },
      equivalence: {
        checked: false,
      },
      confidence: {
        level: 'low',
      },
    });

    expect(
      (result as { confidence: { caveats: string[] } }).confidence.caveats,
    ).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          'Result equivalence check was skipped because the measured query runtime exceeded 10000ms',
        ),
        expect.stringContaining(
          'Timing changed without an access-path signature change',
        ),
      ]),
    );
  });

  it('marks confidence high when equivalence is checked and plan shape changes', async () => {
    const { queryMock } = createDriverQueryMock({
      samePlanShape: false,
      slow: false,
    });
    getDriverInstanceMock.mockResolvedValue({
      query: queryMock,
      close: vi.fn(async () => undefined),
    });

    if (
      !('execute' in CompareQueryRewriteTool) ||
      typeof CompareQueryRewriteTool.execute !== 'function'
    ) {
      throw new Error('CompareQueryRewriteTool does not expose execute.');
    }

    const result = await CompareQueryRewriteTool.execute(
      {
        originalQuery: 'SELECT * FROM original_table',
        rewrittenQuery: 'SELECT * FROM rewritten_table',
        runs: 3,
        checkEquivalence: true,
      },
      createContext(),
    );

    expect(result).toMatchObject({
      delta: {
        planShapeChanged: true,
      },
      equivalence: {
        checked: true,
        equivalent: true,
      },
      confidence: {
        level: 'high',
      },
    });
  });
});
