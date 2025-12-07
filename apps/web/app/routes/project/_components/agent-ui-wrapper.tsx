'use client';

import { useMemo, useImperativeHandle, forwardRef, useRef } from 'react';
import QweryAgentUI from '@qwery/ui/agent-ui';
import { SUPPORTED_MODELS, transportFactory } from '@qwery/agent-factory-sdk';
import { MessageOutput, UsageOutput } from '@qwery/domain/usecases';
import { convertMessages } from '~/lib/utils/messages-converter';
import { useWorkspace } from '~/lib/context/workspace-context';
import { getUsageKey, useGetUsage } from '~/lib/queries/use-get-usage';
import { QweryContextProps } from 'node_modules/@qwery/ui/src/qwery/ai/context';
import { useQueryClient } from '@tanstack/react-query';

export interface AgentUIWrapperRef {
  sendMessage: (text: string) => void;
}

export interface AgentUIWrapperProps {
  conversationSlug: string;
  initialMessages?: MessageOutput[];
}

const convertUsage = (usage: UsageOutput[] | undefined): QweryContextProps => {
  if (!usage || usage.length === 0) {
    return {
      usedTokens: 0,
      maxTokens: 0,
    };
  }

  const aggregated = usage.reduce(
    (acc, curr) => ({
      inputTokens: acc.inputTokens + curr.inputTokens,
      outputTokens: acc.outputTokens + curr.outputTokens,
      totalTokens: acc.totalTokens + curr.totalTokens,
      reasoningTokens: acc.reasoningTokens + curr.reasoningTokens,
      cachedInputTokens: acc.cachedInputTokens + curr.cachedInputTokens,
      maxContextSize: Math.max(acc.maxContextSize, curr.contextSize),
      modelId: curr.model,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      maxContextSize: 128_000,
      modelId: '',
    },
  );

  return {
    usedTokens: aggregated.totalTokens,
    maxTokens: aggregated.maxContextSize,
    modelId: aggregated.modelId || undefined,
    usage: {
      inputTokens: aggregated.inputTokens,
      outputTokens: aggregated.outputTokens,
      totalTokens: aggregated.totalTokens,
      reasoningTokens: aggregated.reasoningTokens,
      cachedInputTokens: aggregated.cachedInputTokens,
    },
  };
};

export const AgentUIWrapper = forwardRef<
  AgentUIWrapperRef,
  AgentUIWrapperProps
>(function AgentUIWrapper({ conversationSlug, initialMessages }, ref) {
  const sendMessageRef = useRef<((text: string) => void) | null>(null);
  const { repositories, workspace } = useWorkspace();
  const { data: usage } = useGetUsage(
    repositories.usage,
    repositories.conversation,
    conversationSlug,
    workspace.userId,
  );
  const queryClient = useQueryClient();
  useImperativeHandle(
    ref,
    () => ({
      sendMessage: (text: string) => {
        sendMessageRef.current?.(text);
      },
    }),
    [],
  );

  const transport = useMemo(
    () => (model: string) => {
      return transportFactory(conversationSlug, model, repositories);
    },
    [conversationSlug, repositories],
  );

  return (
    <QweryAgentUI
      transport={transport}
      initialMessages={convertMessages(initialMessages)}
      models={SUPPORTED_MODELS as { name: string; value: string }[]}
      usage={convertUsage(usage)}
      emitFinish={() => {
        queryClient.invalidateQueries({
          queryKey: getUsageKey(conversationSlug, workspace.userId),
        });
      }}
    />
  );
});
