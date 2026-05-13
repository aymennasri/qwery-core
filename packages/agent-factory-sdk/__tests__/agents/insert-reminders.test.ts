import { describe, expect, it } from 'vitest';
import type { Message } from '@qwery/domain/entities';
import { MessageRole } from '@qwery/domain/entities';
import { DbPerformanceAuditAgent } from '../../src/agents/db-performance-audit-agent';
import { insertReminders } from '../../src/agents/insert-reminders';
import { SlowQueryOptimizerAgent } from '../../src/agents/slow-query-optimizer-agent';

function makeUserMessage(text: string): Message {
  const now = new Date();

  return {
    id: 'message-1',
    conversationId: 'conversation-1',
    role: MessageRole.USER,
    content: {
      parts: [{ type: 'text', text }],
    },
    metadata: {},
    createdAt: now,
    updatedAt: now,
    createdBy: 'test',
    updatedBy: 'test',
  };
}

function getUserTextParts(messages: Message[]): string[] {
  let userMessage: Message | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === MessageRole.USER) {
      userMessage = message;
      break;
    }
  }

  if (!userMessage?.content?.parts) {
    return [];
  }

  return userMessage.content.parts
    .filter(
      (part): part is { type: 'text'; text: string } =>
        part.type === 'text' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text);
}

describe('insertReminders', () => {
  it('does not add todo reminder for db-performance-audit multi-step requests', () => {
    const messages = [
      makeUserMessage(
        'Run the audit, then explain top bottlenecks and list remediation options.',
      ),
    ];

    const result = insertReminders({
      messages,
      agent: DbPerformanceAuditAgent,
      context: {},
    });

    const textParts = getUserTextParts(result);
    expect(textParts.some((text) => text.includes('todo list tool'))).toBe(
      false,
    );
  });

  it('does not add todo reminder for single-step db-performance-audit requests', () => {
    const messages = [makeUserMessage('Audit this datasource.')];

    const result = insertReminders({
      messages,
      agent: DbPerformanceAuditAgent,
      context: {},
    });

    const textParts = getUserTextParts(result);
    expect(textParts.some((text) => text.includes('todo list tool'))).toBe(
      false,
    );
  });

  it('adds datasource reminder and no todo reminder for slow-query-optimizer requests', () => {
    const messages = [
      makeUserMessage('Optimize the slowest queries, then validate fixes.'),
    ];

    const result = insertReminders({
      messages,
      agent: SlowQueryOptimizerAgent,
      context: { attachedDatasourceNames: ['production-db'] },
    });

    const textParts = getUserTextParts(result);
    expect(textParts.some((text) => text.includes('production-db'))).toBe(true);
    expect(textParts.some((text) => text.includes('todo list tool'))).toBe(
      false,
    );
  });
});
