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
    name: 'Ollama Cloud • DeepSeek V3.2',
    shortName: 'DeepSeek V3.2',
    value: 'ollama-cloud/deepseek-v3.2',
  },
  {
    name: 'Ollama Cloud • Devstral Small 2 24B',
    shortName: 'Devstral S2 24B',
    value: 'ollama-cloud/devstral-small-2:24b',
  },
  {
    name: 'Ollama Cloud • Gemma 4 31B',
    shortName: 'Gemma 4 31B',
    value: 'ollama-cloud/gemma4:31b',
  },
  {
    name: 'Ollama Cloud • GLM 4.7',
    shortName: 'GLM 4.7',
    value: 'ollama-cloud/glm-4.7',
  },
  {
    name: 'Ollama Cloud • GPT OSS 120B',
    shortName: 'GPT OSS 120B',
    value: 'ollama-cloud/gpt-oss:120b',
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
    name: 'Ollama Cloud • Nemotron 3 Super',
    shortName: 'Nemotron 3 Super',
    value: 'ollama-cloud/nemotron-3-super',
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
