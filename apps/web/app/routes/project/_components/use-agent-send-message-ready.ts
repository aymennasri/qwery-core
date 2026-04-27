'use client';

import { useCallback } from 'react';
import type { UIMessage } from '@qwery/agent-factory-sdk/browser';
import {
  NOTEBOOK_CELL_TYPE,
  PROMPT_SOURCE,
} from '@qwery/agent-factory-sdk/browser';
import type { NotebookContextValue } from '~/lib/hooks/use-notebook-context';

type SendMessageFn = ((
  message: { text: string },
  options?: { body?: Record<string, unknown> },
) => Promise<void>) & {
  setMessages?: (
    messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => void;
};

type UseAgentSendMessageReadyArgs = {
  sendMessageRef: React.MutableRefObject<
    ((text: string) => Promise<void>) | null
  >;
  internalSendMessageRef: React.MutableRefObject<SendMessageFn | null>;
  currentModelRef: React.MutableRefObject<string>;
  currentAgentRef: React.MutableRefObject<string>;
  setMessagesRef: React.MutableRefObject<
    | ((messages: UIMessage[] | ((prev: UIMessage[]) => UIMessage[])) => void)
    | null
  >;
  sendMessageRafIdRef: React.MutableRefObject<ReturnType<
    typeof requestAnimationFrame
  > | null>;

  getCellDatasource: () => string | undefined;
  getNotebookCellType: () =>
    | NotebookContextValue['notebookCellType']
    | undefined;
  getCellId: () => number | undefined;

  selectedDatasources: string[] | undefined;
  conversation: { id: string } | null | undefined;
  conversationDatasources: string[];
  updateConversation: {
    mutateAsync: (args: {
      id: string;
      datasources: string[];
      updatedBy: string;
    }) => Promise<unknown>;
  };
  workspaceUsername: string | undefined;
  workspaceUserId: string | undefined;
  setPendingDatasources: (ids: string[]) => void;
  setNotebookContext: React.Dispatch<
    React.SetStateAction<NotebookContextValue | undefined>
  >;
};

/**
 * Bridges the UI-level `sendMessage` function (from `@qwery/ui/agent-ui`) into refs used by
 * `AgentUIWrapperRef.sendMessage`, while attaching best-effort context (selected datasources + notebook context).
 */
export function useAgentSendMessageReady({
  sendMessageRef,
  internalSendMessageRef,
  currentModelRef,
  currentAgentRef,
  setMessagesRef,
  sendMessageRafIdRef,
  getCellDatasource,
  getNotebookCellType,
  getCellId,
  selectedDatasources,
  conversation,
  conversationDatasources,
  updateConversation,
  workspaceUsername,
  workspaceUserId,
  setPendingDatasources,
  setNotebookContext,
}: UseAgentSendMessageReadyArgs) {
  return useCallback(
    (sendMessage: SendMessageFn, model: string, agentId: string) => {
      internalSendMessageRef.current = sendMessage;
      currentModelRef.current = model;
      currentAgentRef.current = agentId;
      setMessagesRef.current = sendMessage.setMessages ?? null;

      sendMessageRef.current = async (text: string) => {
        const currentCellDatasource = getCellDatasource();
        const currentNotebookCellType = getNotebookCellType();
        const currentCellId = getCellId();
        const datasourcesToUse = currentCellDatasource
          ? [currentCellDatasource]
          : selectedDatasources && selectedDatasources.length > 0
            ? selectedDatasources
            : undefined;

        if (
          datasourcesToUse &&
          datasourcesToUse.length > 0 &&
          conversation?.id
        ) {
          const currentSorted = [...conversationDatasources].sort();
          const nextSorted = [...datasourcesToUse].sort();
          const datasourcesChanged =
            currentSorted.length !== nextSorted.length ||
            !currentSorted.every(
              (datasourceId, index) => datasourceId === nextSorted[index],
            );

          if (datasourcesChanged) {
            try {
              await updateConversation.mutateAsync({
                id: conversation.id,
                datasources: datasourcesToUse,
                updatedBy: workspaceUsername || workspaceUserId || 'system',
              });
            } catch {
              // Preserve the send path even if datasource sync fails.
            }
          }

          setPendingDatasources(datasourcesToUse);
        } else if (currentCellDatasource) {
          setPendingDatasources([currentCellDatasource]);
        }

        const messageMetadata: Record<string, unknown> = {};
        if (datasourcesToUse && datasourcesToUse.length > 0) {
          messageMetadata.datasources = datasourcesToUse;
        }

        const hasNotebookContext =
          currentCellDatasource ||
          currentNotebookCellType ||
          currentCellId !== undefined;

        if (hasNotebookContext) {
          messageMetadata.promptSource = PROMPT_SOURCE.INLINE;
          messageMetadata.notebookCellType =
            currentNotebookCellType || NOTEBOOK_CELL_TYPE.PROMPT;

          if (currentCellId !== undefined && currentCellDatasource) {
            setNotebookContext({
              cellId: currentCellId,
              notebookCellType: (currentNotebookCellType ||
                NOTEBOOK_CELL_TYPE.PROMPT) as NotebookContextValue['notebookCellType'],
              datasourceId: currentCellDatasource,
            });
          }
        }

        await sendMessage(
          {
            text,
            ...(Object.keys(messageMetadata).length > 0
              ? { metadata: messageMetadata }
              : {}),
          },
          {
            body: {
              model: currentModelRef.current,
              agentId: currentAgentRef.current,
              datasources: datasourcesToUse,
            },
          },
        );

        if (setMessagesRef.current && Object.keys(messageMetadata).length > 0) {
          if (sendMessageRafIdRef.current != null) {
            cancelAnimationFrame(sendMessageRafIdRef.current);
          }

          sendMessageRafIdRef.current = requestAnimationFrame(() => {
            setMessagesRef.current?.((prev: UIMessage[]) => {
              const lastUserMessageIndex = prev.findLastIndex(
                (message: UIMessage) => message.role === 'user',
              );
              if (lastUserMessageIndex < 0) {
                return prev;
              }

              const lastUserMessage = prev[lastUserMessageIndex];
              if (!lastUserMessage) {
                return prev;
              }

              const updated = [...prev];
              updated[lastUserMessageIndex] = {
                ...lastUserMessage,
                metadata: {
                  ...(lastUserMessage.metadata || {}),
                  ...messageMetadata,
                },
              };
              return updated;
            });
          });
        }
      };
    },
    [
      internalSendMessageRef,
      currentModelRef,
      currentAgentRef,
      setMessagesRef,
      sendMessageRef,
      sendMessageRafIdRef,
      getCellDatasource,
      getNotebookCellType,
      getCellId,
      selectedDatasources,
      conversation,
      conversationDatasources,
      updateConversation,
      workspaceUsername,
      workspaceUserId,
      setPendingDatasources,
      setNotebookContext,
    ],
  );
}
