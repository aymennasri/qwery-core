import type { ModelsDevCatalog } from '@qwery/shared/model-cost';

export const SUPPORTED_MODELS = [
  {
    name: 'Azure • GPT-5.2 Chat',
    shortName: 'GPT-5.2 Chat',
    value: 'azure/gpt-5.2-chat',
  },
  {
    name: 'Anthropic • Claude Sonnet 4.5',
    shortName: 'Claude Sonnet 4.5',
    value: 'anthropic/claude-sonnet-4-5-20250929',
  },
  {
    name: 'Ollama Cloud • DeepSeek V3.1 671B',
    shortName: 'DeepSeek V3.1 671B',
    value: 'ollama-cloud/deepseek-v3.1:671b',
  },
  {
    name: 'Ollama Cloud • Gemini 3 Flash (preview)',
    shortName: 'Gemini 3 Flash',
    value: 'ollama-cloud/gemini-3-flash-preview',
  },
  {
    name: 'Ollama Cloud • Gemini 3 Pro (preview)',
    shortName: 'Gemini 3 Pro',
    value: 'ollama-cloud/gemini-3-pro-preview',
  },
  {
    name: 'Ollama Cloud • GLM 5',
    shortName: 'GLM 5',
    value: 'ollama-cloud/glm-5',
  },
  {
    name: 'Ollama Cloud • GLM 5.1',
    shortName: 'GLM 5.1',
    value: 'ollama-cloud/glm-5.1',
  },
  {
    name: 'Ollama Cloud • GPT OSS 120B',
    shortName: 'GPT OSS 120B',
    value: 'ollama-cloud/gpt-oss:120b',
  },
  {
    name: 'Ollama Cloud • Kimi K2.5',
    shortName: 'Kimi K2.5',
    value: 'ollama-cloud/kimi-k2.5',
  },
  {
    name: 'Ollama Cloud • Kimi K2.6',
    shortName: 'Kimi K2.6',
    value: 'ollama-cloud/kimi-k2.6:cloud',
  },
  {
    name: 'Ollama Cloud • MiniMax M2.5',
    shortName: 'MiniMax M2.5',
    value: 'ollama-cloud/minimax-m2.5',
  },
  {
    name: 'Ollama Cloud • MiniMax M2.7',
    shortName: 'MiniMax M2.7',
    value: 'ollama-cloud/minimax-m2.7',
  },
  {
    name: 'Ollama Cloud • Mistral Large 3 675B',
    shortName: 'Mistral L3 675B',
    value: 'ollama-cloud/mistral-large-3:675b',
  },
  {
    name: 'Ollama Cloud • Qwen 3.5 397B',
    shortName: 'Qwen 3.5 397B',
    value: 'ollama-cloud/qwen3.5:397b',
  },
  {
    name: 'Ollama Cloud • Qwen3 Coder 480B',
    shortName: 'Qwen3 Coder 480B',
    value: 'ollama-cloud/qwen3-coder:480b',
  },
  {
    name: 'Ollama Cloud • Nemotron 3 Super',
    shortName: 'Nemotron 3 Super',
    value: 'ollama-cloud/nemotron-3-super',
  },
  {
    name: 'Ollama Cloud • Devstral 2 123B',
    shortName: 'Devstral 2 123B',
    value: 'ollama-cloud/devstral-2:123b',
  },
  {
    name: 'WebLLM • Llama 3.1 8B',
    shortName: 'Llama 3.1 8B',
    value: 'webllm/Llama-3.1-8B-Instruct-q4f32_1-MLC',
  },
  {
    name: 'Transformers.js • SmolLM2 360M',
    shortName: 'SmolLM2 360M',
    value: 'transformer-browser/SmolLM2-360M-Instruct',
  },
  {
    name: 'Built-in Browser',
    shortName: 'Browser',
    value: 'browser/built-in',
  },
];

export async function getModelsCatalog(): Promise<ModelsDevCatalog> {
  return {};
}
