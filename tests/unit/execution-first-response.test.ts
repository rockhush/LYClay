import { describe, expect, it } from 'vitest';
import { hasAssistantFirstResponseActivity } from '@/stores/chat/helpers';
import type { RawMessage } from '@/stores/chat/types';

describe('hasAssistantFirstResponseActivity', () => {
  it('detects thinking blocks as first model output', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me check the skill.' }],
    };
    expect(hasAssistantFirstResponseActivity(message)).toBe(true);
  });

  it('detects tool calls as first model output', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 't1', name: 'read', input: { path: 'SKILL.md' } }],
    };
    expect(hasAssistantFirstResponseActivity(message)).toBe(true);
  });

  it('detects non-suppressed assistant text', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: '这个 skill 是...' }],
    };
    expect(hasAssistantFirstResponseActivity(message)).toBe(true);
  });

  it('ignores suppressed silent plumbing text', () => {
    const message: RawMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'NO_REPLY' }],
    };
    expect(hasAssistantFirstResponseActivity(message)).toBe(false);
  });

  it('detects top-level reasoning_content deltas', () => {
    const message = {
      role: 'assistant',
      reasoning_content: 'The user is asking about the skill.',
    } as RawMessage;
    expect(hasAssistantFirstResponseActivity(message)).toBe(true);
  });

  it('ignores empty reasoning-only placeholder deltas', () => {
    const message = {
      role: 'assistant',
      content: undefined,
    } as RawMessage;
    expect(hasAssistantFirstResponseActivity(message)).toBe(false);
  });

  it('ignores tool results', () => {
    const message: RawMessage = {
      role: 'tool',
      content: [{ type: 'text', text: 'file contents' }],
    };
    expect(hasAssistantFirstResponseActivity(message)).toBe(false);
  });
});
