// Export all from subdirectories
export * from './domain';
export * from './services';
export * from './agents';

// Export tool types
export * from './agents/tools/types';
export * from './agents/tools/inferred-types';

// Export config (browser-safe: skills cache only; use @qwery/agent-factory-sdk/config/node for disk loaders)
export * from './config';

// Export tool definitions (browser-safe)
export * from './tools/tool';

// Export MCP client (for advanced use; Registry.tools.forAgent uses it when mcpServerUrl is set)
export {
  getMcpTools,
  type GetMcpToolsOptions,
  type GetMcpToolsResult,
  type McpServerConfig,
} from './mcp/index.js';

// Reexport AI SDK
export type { UIMessage } from 'ai';
export {
  convertToModelMessages,
  streamText,
  generateText,
  validateUIMessages,
} from 'ai';
export { createAzure } from '@ai-sdk/azure';
export { createAnthropic } from '@ai-sdk/anthropic';
export { SUPPORTED_MODELS } from './model-catalog';
