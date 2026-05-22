import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDriverInstanceMock, extensionsRegistryGetMock, loggerDebugMock } =
  vi.hoisted(() => ({
    getDriverInstanceMock: vi.fn(),
    extensionsRegistryGetMock: vi.fn(),
    loggerDebugMock: vi.fn(),
  }));

vi.mock('@qwery/extensions-loader', () => ({
  getDriverInstance: getDriverInstanceMock,
}));

vi.mock('@qwery/extensions-sdk', () => ({
  ExtensionsRegistry: {
    get: extensionsRegistryGetMock,
  },
}));

vi.mock('@qwery/shared/logger', () => ({
  getLogger: vi.fn(async () => ({
    debug: loggerDebugMock,
  })),
}));

import { RunQueryTool } from '../../src/tools/run-query';

describe('RunQueryTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createContext(input: {
    agentId?: string;
    findById: ReturnType<typeof vi.fn>;
  }) {
    return {
      conversationId: 'conversation-1',
      agentId: input.agentId ?? 'db-performance-audit',
      abort: new AbortController().signal,
      messages: [],
      ask: async () => undefined,
      metadata: async () => undefined,
      extra: {
        repositories: {
          datasource: {
            findById: input.findById,
          },
        },
        attachedDatasources: ['ds1'],
      },
    };
  }

  it('uses the requested datasourceId instead of the first attached datasource', async () => {
    const findById = vi.fn().mockResolvedValueOnce({
      id: 'ds2',
      datasource_provider: 'postgres',
      config: { connectionUrl: 'postgresql://db' },
    });
    const close = vi.fn(async () => undefined);

    extensionsRegistryGetMock.mockReturnValue({
      drivers: [{ runtime: 'node' }],
    });
    getDriverInstanceMock.mockResolvedValue({
      query: vi.fn(async () => ({
        columns: ['value'],
        rows: [{ value: 1 }],
      })),
      close,
    });

    if (
      !('execute' in RunQueryTool) ||
      typeof RunQueryTool.execute !== 'function'
    ) {
      throw new Error(
        'RunQueryTool does not expose a synchronous execute function',
      );
    }

    const result = await RunQueryTool.execute(
      {
        datasourceId: 'ds2',
        query: 'SELECT 1 AS value',
        exportFilename: 'value',
      },
      createContext({ findById }),
    );

    expect(findById).toHaveBeenCalledWith('ds2');
    expect(result).toMatchObject({
      executed: true,
      result: {
        columns: ['value'],
        rows: [{ value: 1 }],
      },
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it('blocks write-capable SQL for db-performance-audit before opening a driver', async () => {
    const findById = vi.fn();

    if (
      !('execute' in RunQueryTool) ||
      typeof RunQueryTool.execute !== 'function'
    ) {
      throw new Error(
        'RunQueryTool does not expose a synchronous execute function',
      );
    }

    await expect(
      RunQueryTool.execute(
        {
          datasourceId: 'ds2',
          query: 'ALTER TABLE users ADD COLUMN audited_at timestamptz',
          exportFilename: 'blocked-write',
        },
        createContext({ findById }),
      ),
    ).rejects.toThrow('Only read-only SQL statements are allowed');

    expect(findById).not.toHaveBeenCalled();
    expect(extensionsRegistryGetMock).not.toHaveBeenCalled();
    expect(getDriverInstanceMock).not.toHaveBeenCalled();
  });

  it('blocks write-capable SQL for slow-query-optimizer before opening a driver', async () => {
    const findById = vi.fn();

    if (
      !('execute' in RunQueryTool) ||
      typeof RunQueryTool.execute !== 'function'
    ) {
      throw new Error(
        'RunQueryTool does not expose a synchronous execute function',
      );
    }

    await expect(
      RunQueryTool.execute(
        {
          datasourceId: 'ds2',
          query: 'CREATE INDEX CONCURRENTLY idx_users_email ON users (email)',
          exportFilename: 'blocked-write',
        },
        createContext({
          agentId: 'slow-query-optimizer',
          findById,
        }),
      ),
    ).rejects.toThrow('Only read-only SQL statements are allowed');

    expect(findById).not.toHaveBeenCalled();
    expect(extensionsRegistryGetMock).not.toHaveBeenCalled();
    expect(getDriverInstanceMock).not.toHaveBeenCalled();
  });
});
