import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getMcpToolsMock, loggerWarnMock } = vi.hoisted(() => ({
  getMcpToolsMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../src/mcp/client.js', () => ({
  getMcpTools: getMcpToolsMock,
}));

vi.mock('@qwery/shared/logger', () => ({
  getLogger: vi.fn(async () => ({
    warn: loggerWarnMock,
  })),
}));

import { Registry } from '../../src/tools/registry';

const MODEL = { providerId: 'test', modelId: 'test' };
const makeMcpOptions = () =>
  ({
    mcpServers: [
      { url: 'http://localhost/mcp' },
      { url: 'http://127.0.0.1:8811/mcp', namePrefix: 'gfs_' },
    ],
  }) as Parameters<typeof Registry.tools.forAgent>[3];

function createToolContext() {
  return {
    conversationId: 'conversation-1',
    agentId: 'db-performance-audit',
    abort: new AbortController().signal,
    messages: [],
    ask: async () => {},
    metadata: () => {},
  };
}

describe('Registry MCP integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('merges multiple MCP servers and prefixes GFS tools', async () => {
    const closePrimary = vi.fn(async () => {});
    const closeGfs = vi.fn(async () => {});

    getMcpToolsMock
      .mockResolvedValueOnce({
        tools: { list_datasources: {} },
        close: closePrimary,
      })
      .mockResolvedValueOnce({
        tools: { gfs_status: {} },
        close: closeGfs,
      });

    const result = await Registry.tools.forAgent(
      'db-performance-audit',
      MODEL,
      () => createToolContext(),
      makeMcpOptions(),
    );

    expect(getMcpToolsMock).toHaveBeenNthCalledWith(1, 'http://localhost/mcp', {
      headers: undefined,
      namePrefix: undefined,
    });
    expect(getMcpToolsMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:8811/mcp',
      {
        headers: undefined,
        namePrefix: 'gfs_',
      },
    );
    expect(result.tools).toHaveProperty('list_datasources');
    expect(result.tools).toHaveProperty('gfs_status');

    await result.close?.();

    expect(closePrimary).toHaveBeenCalledOnce();
    expect(closeGfs).toHaveBeenCalledOnce();
  });

  it('keeps available tools when one MCP server fails', async () => {
    const closePrimary = vi.fn(async () => {});

    getMcpToolsMock
      .mockResolvedValueOnce({
        tools: { list_datasources: {} },
        close: closePrimary,
      })
      .mockRejectedValueOnce(new Error('gfs offline'));

    const result = await Registry.tools.forAgent(
      'db-performance-audit',
      MODEL,
      () => createToolContext(),
      makeMcpOptions(),
    );

    expect(result.tools).toHaveProperty('list_datasources');
    expect(result.tools).not.toHaveProperty('gfs_status');
    expect(loggerWarnMock).toHaveBeenCalledOnce();

    await result.close?.();

    expect(closePrimary).toHaveBeenCalledOnce();
  });
});
