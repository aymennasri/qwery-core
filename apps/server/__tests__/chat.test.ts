import { beforeEach, describe, expect, it, vi } from 'vitest';

const promptMock = vi.fn();
const validateUIMessagesMock = vi.fn(async ({ messages }) => messages);
const resolveChatDatasourcesMock = vi.fn(async () => ['ds-from-context']);

vi.mock('@qwery/agent-factory-sdk', () => ({
  prompt: promptMock,
  getDefaultModel: vi.fn(() => 'test-model'),
  validateUIMessages: validateUIMessagesMock,
  PROMPT_SOURCE: {
    CHAT: 'chat',
    INLINE: 'inline',
  },
}));

vi.mock('@qwery/agent-factory-sdk/tools/registry', () => ({
  Registry: {
    agents: {
      get: vi.fn((agentId: string) =>
        ['db-performance-audit', 'slow-query-optimizer'].includes(agentId)
          ? { id: agentId }
          : undefined,
      ),
    },
  },
}));

vi.mock('../src/lib/repositories', () => ({
  createRepositories: vi.fn(async () => ({
    conversation: {
      findBySlug: vi.fn(async () => null),
    },
  })),
}));

vi.mock('../src/lib/telemetry', () => ({
  getTelemetry: vi.fn(async () => ({ service: 'test-telemetry' })),
}));

vi.mock('../src/helpers/chat-helper', () => ({
  resolveChatDatasources: resolveChatDatasourcesMock,
}));

describe('Server API - Chat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    promptMock.mockResolvedValue(new Response('stream ok', { status: 200 }));
    validateUIMessagesMock.mockImplementation(async ({ messages }) => messages);
    resolveChatDatasourcesMock.mockResolvedValue(['ds-from-context']);
  });

  it('rejects invalid request bodies', async () => {
    const { createChatRoutes } = await import('../src/routes/chat');
    const app = createChatRoutes();

    const res = await app.request('http://localhost/test-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it('rejects unknown agent ids before prompt execution', async () => {
    const { createChatRoutes } = await import('../src/routes/chat');
    const app = createChatRoutes();

    const res = await app.request('http://localhost/test-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'unknown-agent',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
      }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Invalid agentId: unknown-agent',
    });
    expect(promptMock).not.toHaveBeenCalled();
  });

  it('passes agentId and datasource context into prompt execution', async () => {
    const { createChatRoutes } = await import('../src/routes/chat');
    const app = createChatRoutes();

    const response = await app.request('http://localhost/test-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'db-performance-audit',
        messages: [
          {
            role: 'user',
            parts: [
              {
                type: 'text',
                text: 'Run a PostgreSQL audit',
              },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(resolveChatDatasourcesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyDatasources: undefined,
        conversationSlug: 'test-slug',
      }),
    );
    expect(validateUIMessagesMock).toHaveBeenCalled();
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationSlug: 'test-slug',
        model: 'test-model',
        agentId: 'db-performance-audit',
        datasources: ['ds-from-context'],
        generateTitle: true,
      }),
    );
  });

  it('passes only the primary MCP server into prompt execution', async () => {
    const { createChatRoutes } = await import('../src/routes/chat');
    const app = createChatRoutes();

    const response = await app.request('http://localhost/test-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'db-performance-audit',
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'audit' }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerUrl: 'http://localhost/mcp',
        mcpServers: [{ url: 'http://localhost/mcp' }],
      }),
    );
  });

  it('accepts the slow-query-optimizer agent id', async () => {
    const { createChatRoutes } = await import('../src/routes/chat');
    const app = createChatRoutes();

    const response = await app.request('http://localhost/test-slug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentId: 'slow-query-optimizer',
        messages: [
          {
            role: 'user',
            parts: [{ type: 'text', text: 'Optimize my slowest queries' }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(promptMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'slow-query-optimizer',
      }),
    );
  });
});
