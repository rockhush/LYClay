import { describe, expect, it } from 'vitest';
import {
  countUnresolvedStreamingToolUses,
  deriveTaskSteps,
  findReplyMessageIndex,
  shouldPromoteStreamingTextAsReply,
} from '@/pages/Chat/task-visualization';
import { extractText } from '@/pages/Chat/message-utils';
import type { RawMessage } from '@/stores/chat';

type FinalFoldingState =
  | 'tool-history'
  | 'cumulative-final-stream'
  | 'final-event-with-stale-history'
  | 'authoritative-terminal-history';

interface StateSnapshot {
  state: FinalFoldingState;
  messages: RawMessage[];
  streamingMessage: RawMessage | null;
}

const firstNarration = 'I will gather the latest intelligence first.';
const secondNarration = 'I have enough data and will compile the report.';
const finalReply = '# LY Intelligence Report\n\nKimi model activity is included in today\'s summary.';

const toolHistory: RawMessage[] = [
  {
    role: 'assistant',
    id: 'tool-round-1',
    stopReason: 'toolUse',
    content: [
      { type: 'text', text: firstNarration },
      { type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: 'https://example.com/1' } },
    ],
  },
  { role: 'toolResult', toolCallId: 'fetch-1', content: 'source one' },
  {
    role: 'assistant',
    id: 'tool-round-2',
    stopReason: 'toolUse',
    content: [
      { type: 'text', text: secondNarration },
      { type: 'toolCall', id: 'fetch-2', name: 'web_fetch', arguments: { url: 'https://example.com/2' } },
    ],
  },
  { role: 'toolResult', toolCallId: 'fetch-2', content: 'source two' },
];

const cumulativeFinalStream: RawMessage = {
  role: 'assistant',
  content: [
    { type: 'text', text: `${firstNarration}${secondNarration}${finalReply}` },
    // Some provider deltas retain a previous tool call until the terminal event.
    { type: 'toolCall', id: 'fetch-2', name: 'web_fetch', arguments: { url: 'https://example.com/2' } },
  ],
};

const authoritativeFinal: RawMessage = {
  role: 'assistant',
  id: 'authoritative-final',
  stopReason: 'stop',
  content: [{ type: 'text', text: finalReply }],
};

function transition(
  current: StateSnapshot,
  event: 'stream-cumulative-final' | 'receive-final-event' | 'history-catches-up',
): StateSnapshot {
  switch (event) {
    case 'stream-cumulative-final':
      return {
        state: 'cumulative-final-stream',
        messages: current.messages,
        streamingMessage: cumulativeFinalStream,
      };
    case 'receive-final-event':
      return {
        state: 'final-event-with-stale-history',
        messages: current.messages,
        streamingMessage: null,
      };
    case 'history-catches-up':
      return {
        state: 'authoritative-terminal-history',
        messages: [...current.messages, authoritativeFinal],
        streamingMessage: null,
      };
  }
}

function present(snapshot: StateSnapshot) {
  const streamText = snapshot.streamingMessage ? extractText(snapshot.streamingMessage) : '';
  const streamToolUseCount = snapshot.streamingMessage
    ? countUnresolvedStreamingToolUses({
      messages: snapshot.messages,
      streamingMessage: snapshot.streamingMessage,
      streamingTools: [],
    })
    : 0;
  const promoteStreamToReply = snapshot.streamingMessage != null
    && shouldPromoteStreamingTextAsReply({
      streamText,
      hasStreamImages: false,
      streamToolUseCount,
    });
  const replyIndex = findReplyMessageIndex(
    snapshot.messages,
    snapshot.streamingMessage != null,
  );
  const steps = deriveTaskSteps({
    messages: snapshot.messages,
    streamingMessage: snapshot.streamingMessage,
    streamingTools: [],
    omitLastStreamingMessageSegment: promoteStreamToReply,
    includeHiddenToolSteps: true,
    committedReplyIndex: replyIndex >= 0 ? replyIndex : null,
  });

  return { promoteStreamToReply, replyIndex, steps };
}

describe('cumulative final folding state machine', () => {
  it('deterministically reproduces the folded-final race and its authoritative recovery', () => {
    let snapshot: StateSnapshot = {
      state: 'tool-history',
      messages: toolHistory,
      streamingMessage: null,
    };

    snapshot = transition(snapshot, 'stream-cumulative-final');
    let presentation = present(snapshot);
    expect(snapshot.state).toBe('cumulative-final-stream');
    expect(presentation.promoteStreamToReply).toBe(true);
    expect(presentation.replyIndex).toBe(-1);
    expect(presentation.steps.some(
      (step) => step.kind === 'message' && step.detail?.includes(finalReply),
    )).toBe(false);
    expect(presentation.steps.find((step) => step.id === 'fetch-2')?.status).toBe('completed');

    snapshot = transition(snapshot, 'receive-final-event');
    presentation = present(snapshot);
    expect(snapshot.state).toBe('final-event-with-stale-history');
    expect(presentation.replyIndex).toBe(-1);
    expect(presentation.steps.some((step) => step.detail?.includes(finalReply))).toBe(false);

    snapshot = transition(snapshot, 'history-catches-up');
    presentation = present(snapshot);
    expect(snapshot.state).toBe('authoritative-terminal-history');
    expect(presentation.replyIndex).toBe(snapshot.messages.length - 1);
    expect(extractText(snapshot.messages[presentation.replyIndex])).toBe(finalReply);
    expect(presentation.steps.some((step) => step.detail?.includes(finalReply))).toBe(false);
  });

  it('only treats a historical tool id as stale when the stream extends its narration', () => {
    const historicalToolRound = toolHistory[0]!;
    const sameNarrationStream: RawMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: firstNarration },
        { type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: {} },
      ],
    };
    const cumulativeReplyStream: RawMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: `${firstNarration} ${finalReply}` },
        { type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: {} },
      ],
    };

    expect(countUnresolvedStreamingToolUses({
      messages: [historicalToolRound],
      streamingMessage: sameNarrationStream,
      streamingTools: [],
    })).toBe(1);
    expect(countUnresolvedStreamingToolUses({
      messages: [historicalToolRound],
      streamingMessage: cumulativeReplyStream,
      streamingTools: [],
    })).toBe(0);
  });
  it('keeps narration in the graph while an attached tool call is genuinely unresolved', () => {
    const unresolvedToolCount = countUnresolvedStreamingToolUses({
      messages: [],
      streamingMessage: cumulativeFinalStream,
      streamingTools: [],
    });

    expect(unresolvedToolCount).toBe(1);
    expect(shouldPromoteStreamingTextAsReply({
      streamText: extractText(cumulativeFinalStream),
      hasStreamImages: false,
      streamToolUseCount: unresolvedToolCount,
    })).toBe(false);

    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: cumulativeFinalStream,
      streamingTools: [],
      includeHiddenToolSteps: true,
    });
    expect(steps.some(
      (step) => step.kind === 'message' && step.detail?.includes(finalReply),
    )).toBe(true);
    expect(steps.find((step) => step.id === 'fetch-2')?.status).toBe('running');
  });
});