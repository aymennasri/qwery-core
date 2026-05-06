import {
  azure as defaultAzureProvider,
  createAzure,
  type AzureOpenAIProvider,
  type AzureOpenAIProviderSettings,
} from '@ai-sdk/azure';
import { LanguageModel } from 'ai';

type ModelProvider = {
  resolveModel: (modelName: string) => LanguageModel;
};

export type AzureModelProviderOptions = AzureOpenAIProviderSettings & {
  deployment?: string;
  provider?: AzureOpenAIProvider;
};

export function createAzureModelProvider({
  deployment,
  provider,
  ...azureOptions
}: AzureModelProviderOptions): ModelProvider {
  const resolvedProvider: AzureOpenAIProvider =
    provider ??
    (Object.keys(azureOptions).length > 0
      ? createAzure(azureOptions)
      : defaultAzureProvider);

  return {
    resolveModel: (modelName) => {
      const finalDeployment = modelName || deployment;
      if (!finalDeployment) {
        throw new Error(
          `[AgentFactory] Missing Azure deployment. Provide model name as 'azure/<deployment>' or set AZURE_OPENAI_DEPLOYMENT.`,
        );
      }

      // Use Azure Responses API by default so Codex and newer GPT-5 deployments
      // work through the same provider path as standard text generation.
      return resolvedProvider.responses(finalDeployment);
    },
  };
}
