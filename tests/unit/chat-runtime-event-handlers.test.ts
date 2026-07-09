import { beforeEach, describe, expect, it, vi } from 'vitest';

const clearErrorRecoveryTimer = vi.fn();
const clearHistoryPoll = vi.fn();
const collectToolUpdates = vi.fn(() => []);
const extractImagesAsAttachedFiles = vi.fn(() => []);
const extractMediaRefs = vi.fn(() => []);
const extractRawFilePaths = vi.fn(() => []);
const getMessageText = vi.fn(() => '');
const getMessageErrorMessage = vi.fn((message: { errorMessage?: string; error_message?: string } | undefined) =>
  message?.errorMessage ?? message?.error_message ?? null);
const getToolCallFilePath = vi.fn(() => undefined);
const hasErrorRecoveryTimer = vi.fn(() => false);
const hasNonToolAssistantContent = vi.fn(() => true);
const hasVisibleAssistantContent = vi.fn((message: { content?: unknown } | undefined) => {
  if (!message) return false;
  const text = getMessageText(message.content);
  return Boolean(text.trim());
});
const shouldSuppressAssistantStreamingText = vi.fn(() => false);
const shouldTreatAbortAsUserStop = vi.fn(() => false);
const abortedChatRunIds = new Set<string>();
const markAbortedChatRun = vi.fn((runId: string) => {
  const id = runId.trim();
  if (id) abortedChatRunIds.add(id);
});
const forgetAbortedChatRun = vi.fn((runId: string) => {
  abortedChatRunIds.delete(runId.trim());
});
const isAbortedChatRun = vi.fn((runId: string) => abortedChatRunIds.has(runId.trim()));
const isBackendRunFailureError = vi.fn(() => false);
const isRecoverableRuntimeError = vi.fn(() => false);
const truncateRunErrorMessage = vi.fn((message: string) => message);
const resolveRunFailureErrorMessage = vi.fn((message: string) => message);
const isInternalMessage = vi.fn(() => false);
const isInternalMessageText = vi.fn(() => false);
const isUserSecurityDenialMessage = vi.fn((message: unknown) =>
  typeof message === 'string' && /NETWORK_ACCESS_DENIED_BY_USER|Network access denied:/i.test(message));
const isSuppressedRunError = vi.fn(() => false);
const shouldSuppressPartialSuccessRunError = vi.fn(() => false);
const buildSecurityCancelNotice = vi.fn(() => 'Cancelled: you declined the security confirmation.');
const isTerminalAssistantErrorMessage = vi.fn((message: { role?: string; stopReason?: string; stop_reason?: string } | undefined) => {
  const stopReason = message?.stopReason ?? message?.stop_reason;
  return message?.role === 'assistant' && stopReason === 'error';
});
const isToolOnlyMessage = vi.fn(() => false);
const isToolResultRole = vi.fn((role: unknown) => role === 'toolresult' || role === 'toolResult' || role === 'tool_result');
const makeAttachedFile = vi.fn((ref: { filePath: string; mimeType: string }, source?: 'user-upload' | 'tool-result' | 'message-ref') => ({
  fileName: ref.filePath.split('/').pop() || 'file',
  mimeType: ref.mimeType,
  fileSize: 0,
  preview: null,
  filePath: ref.filePath,
  source,
}));
const normalizeStreamingMessage = vi.fn((message: unknown) => message);
const setErrorRecoveryTimer = vi.fn();
const snapshotStreamingAssistantMessage = vi.fn((currentStream: unknown) => currentStream ? [currentStream] : []);
const upsertToolStatuses = vi.fn((_current, updates) => updates);

vi.mock('@/stores/chat/helpers', () => ({
  clearErrorRecoveryTimer: (...args: unknown[]) => clearErrorRecoveryTimer(...args),
  clearHistoryPoll: (...args: unknown[]) => clearHistoryPoll(...args),
  collectToolUpdates: (...args: unknown[]) => collectToolUpdates(...args),
  extractImagesAsAttachedFiles: (...args: unknown[]) => extractImagesAsAttachedFiles(...args),
  extractMediaRefs: (...args: unknown[]) => extractMediaRefs(...args),
  getMessageErrorMessage: (...args: unknown[]) => getMessageErrorMessage(...args),
  extractRawFilePaths: (...args: unknown[]) => extractRawFilePaths(...args),
  getMessageText: (...args: unknown[]) => getMessageText(...args),
  getToolCallFilePath: (...args: unknown[]) => getToolCallFilePath(...args),
  hasErrorRecoveryTimer: (...args: unknown[]) => hasErrorRecoveryTimer(...args),
  hasNonToolAssistantContent: (...args: unknown[]) => hasNonToolAssistantContent(...args),
  hasVisibleAssistantContent: (...args: unknown[]) => hasVisibleAssistantContent(...args),
  shouldSuppressAssistantStreamingText: (...args: unknown[]) => shouldSuppressAssistantStreamingText(...args),
  shouldTreatAbortAsUserStop: (...args: unknown[]) => shouldTreatAbortAsUserStop(...args),
  isAbortedChatRun: (...args: unknown[]) => isAbortedChatRun(...args),
  markAbortedChatRun: (...args: unknown[]) => markAbortedChatRun(...args),
  forgetAbortedChatRun: (...args: unknown[]) => forgetAbortedChatRun(...args),
  isBackendRunFailureError: (...args: unknown[]) => isBackendRunFailureError(...args),
  isRecoverableRuntimeError: (...args: unknown[]) => isRecoverableRuntimeError(...args),
  truncateRunErrorMessage: (...args: unknown[]) => truncateRunErrorMessage(...args),
  resolveRunFailureErrorMessage: (...args: unknown[]) => resolveRunFailureErrorMessage(...args),
  attachmentFileNameFromPath: (filePath: string) => filePath.split(/[/\\]/).pop() || filePath,
  isInternalMessage: (...args: unknown[]) => isInternalMessage(...args),
  isInternalMessageText: (...args: unknown[]) => isInternalMessageText(...args),
  isUserSecurityDenialMessage: (...args: unknown[]) => isUserSecurityDenialMessage(...args),
  isSuppressedRunError: (...args: unknown[]) => isSuppressedRunError(...args),
  shouldSuppressPartialSuccessRunError: (...args: unknown[]) => shouldSuppressPartialSuccessRunError(...args),
  buildSecurityCancelNotice: (...args: unknown[]) => buildSecurityCancelNotice(...args),
  isTerminalAssistantErrorMessage: (...args: unknown[]) => isTerminalAssistantErrorMessage(...args),
  isToolOnlyMessage: (...args: unknown[]) => isToolOnlyMessage(...args),
  isToolResultRole: (...args: unknown[]) => isToolResultRole(...args),
  makeAttachedFile: (...args: unknown[]) => makeAttachedFile(...args),
  normalizeStreamingMessage: (...args: unknown[]) => normalizeStreamingMessage(...args),
  setErrorRecoveryTimer: (...args: unknown[]) => setErrorRecoveryTimer(...args),
  snapshotStreamingAssistantMessage: (...args: unknown[]) => snapshotStreamingAssistantMessage(...args),
  upsertToolStatuses: (...args: unknown[]) => upsertToolStatuses(...args),
}));

type ChatLikeState = {
  sending: boolean;
  aborting: boolean;
  activeRunId: string | null;
  currentSessionKey?: string | null;
  error: string | null;
  runError: string | null;
  streamingMessage: unknown | null;
  streamingTools: unknown[];
  messages: Array<Record<string, unknown>>;
  pendingToolImages: unknown[];
  pendingFinal: boolean;
  lastUserMessageAt: number | null;
  streamingText: string;
  runAborted?: boolean;
  contextCompressionStatus: unknown | null;
  loadHistory: ReturnType<typeof vi.fn>;
  sessionStreamingStates: Record<string, unknown>;
};

function makeHarness(initial?: Partial<ChatLikeState>) {
  let state: ChatLikeState = {
    sending: false,
    aborting: false,
    activeRunId: 'run-default',
    currentSessionKey: null,
    error: 'stale error',
    runError: null,
    streamingMessage: null,
    streamingTools: [],
    messages: [],
    pendingToolImages: [],
    pendingFinal: false,
    lastUserMessageAt: null,
    streamingText: '',
    loadHistory: vi.fn(),
    sessionStreamingStates: {},
    ...initial,
  };

  const set = (partial: Partial<ChatLikeState> | ((s: ChatLikeState) => Partial<ChatLikeState>)) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    state = { ...state, ...next };
  };
  const get = () => state;
  return { set, get, read: () => state };
}

describe('chat runtime event handlers', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    abortedChatRunIds.clear();
    hasErrorRecoveryTimer.mockReturnValue(false);
    collectToolUpdates.mockReturnValue([]);
    getMessageText.mockImplementation((content: unknown) => {
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter((block): block is { type?: string; text: string } => {
            return typeof block === 'object' && block != null && (block as { type?: string }).type === 'text' && typeof (block as { text?: unknown }).text === 'string';
          })
          .map((block) => block.text)
          .join('\n');
      }
      return '';
    });
    isInternalMessageText.mockImplementation((text: unknown) => /^(HEARTBEAT_OK|NO_REPLY)\s*$/.test(String(text).trim()));
    isUserSecurityDenialMessage.mockImplementation((message: unknown) =>
      typeof message === 'string' && /NETWORK_ACCESS_DENIED_BY_USER|Network access denied:/i.test(message));
    normalizeStreamingMessage.mockImplementation((message: unknown) => message);
    snapshotStreamingAssistantMessage.mockImplementation((currentStream: unknown) => currentStream ? [currentStream as Record<string, unknown>] : []);
    upsertToolStatuses.mockImplementation((_current, updates) => updates);
    isBackendRunFailureError.mockReturnValue(false);
    isRecoverableRuntimeError.mockReturnValue(false);
    truncateRunErrorMessage.mockImplementation((message: string) => message);
    resolveRunFailureErrorMessage.mockImplementation((message: string) => message);
  });

  it('marks sending on started event', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ sending: false, activeRunId: null, error: 'err' });

    handleRuntimeEventState(h.set as never, h.get as never, {}, 'started', 'run-1');
    const next = h.read();
    expect(next.sending).toBe(true);
    expect(next.activeRunId).toBe('run-1');
    expect(next.error).toBeNull();
  });

  it('applies delta event and clears stale error when recovery timer exists', async () => {
    hasErrorRecoveryTimer.mockReturnValue(true);
    collectToolUpdates.mockReturnValue([{ name: 'tool-a', status: 'running', updatedAt: 1 }]);

    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({
      error: 'old',
      streamingTools: [],
      streamingMessage: { role: 'assistant', content: 'old' },
    });
    const event = { message: { role: 'assistant', content: 'delta' } };

    handleRuntimeEventState(h.set as never, h.get as never, event, 'delta', 'run-2');
    const next = h.read();
    expect(clearErrorRecoveryTimer).toHaveBeenCalledTimes(1);
    expect(next.error).toBeNull();
    expect(next.runError).toBeNull();
    expect(next.streamingMessage).toEqual(event.message);
    expect(next.streamingTools).toEqual([{ name: 'tool-a', status: 'running', updatedAt: 1 }]);
  });

  it('finalizes when final event has no message and reloads history', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ sending: true, activeRunId: 'run-3', pendingFinal: true, lastUserMessageAt: 123 });

    handleRuntimeEventState(h.set as never, h.get as never, {}, 'final', 'run-3');
    const next = h.read();
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(next.pendingFinal).toBe(false);
    expect(next.streamingMessage).toBeNull();
    expect(next.lastUserMessageAt).toBeNull();
    expect(h.read().loadHistory).toHaveBeenCalledTimes(1);
  });

  it('reloads history with force after assistant final with visible text and tool_use', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({
      sending: true,
      activeRunId: 'run-mixed',
      pendingFinal: true,
      lastUserMessageAt: 123,
      currentSessionKey: 'agent:main:session-1',
    });

    handleRuntimeEventState(h.set as never, h.get as never, {
      sessionKey: 'agent:main:session-1',
      message: {
        role: 'assistant',
        id: 'assistant-mixed',
        content: [
          { type: 'text', text: 'Here is the summary.' },
          { type: 'tool_use', id: 'call-1', name: 'image', input: {} },
        ],
      },
    }, 'final', 'run-mixed');

    expect(h.read().loadHistory).toHaveBeenCalledWith(true, { force: true });
  });

  it('marks tool-result attachments before appending them to the final assistant reply', async () => {
    extractMediaRefs.mockReturnValue([{ filePath: '/tmp/CHECKLIST.md', mimeType: 'text/markdown' }]);
    getMessageText.mockReturnValue('[media attached: /tmp/CHECKLIST.md (text/markdown) | /tmp/CHECKLIST.md]');
    hasNonToolAssistantContent.mockReturnValue(true);

    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({
      pendingToolImages: [],
      streamingMessage: {
        role: 'assistant',
        id: 'streaming-assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { filePath: '/tmp/CHECKLIST.md' } }],
      },
    });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: '[media attached: /tmp/CHECKLIST.md (text/markdown) | /tmp/CHECKLIST.md]' }],
      },
    }, 'final', 'run-4');

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        id: 'final-assistant',
        content: [{ type: 'text', text: 'Done.' }],
      },
    }, 'final', 'run-4');

    expect(h.read().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'final-assistant',
        _attachedFiles: [
          expect.objectContaining({
            filePath: '/tmp/CHECKLIST.md',
            source: 'tool-result',
          }),
        ],
      }),
    ]));
  });

  it('handles error event and finalizes immediately when not sending', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ sending: false, activeRunId: 'r1', lastUserMessageAt: 123 });

    handleRuntimeEventState(h.set as never, h.get as never, { errorMessage: 'boom' }, 'error', 'r1');
    const next = h.read();
    expect(clearHistoryPoll).toHaveBeenCalledTimes(1);
    expect(next.error).toBe('boom');
    expect(next.runError).toBe('boom');
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(next.lastUserMessageAt).toBeNull();
    expect(next.streamingTools).toEqual([]);
  });

  it('treats user-denied security confirmations as cancellation instead of chat errors', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({
      sending: true,
      activeRunId: 'r1',
      lastUserMessageAt: 123,
      streamingMessage: { role: 'assistant', content: 'partial' },
      streamingTools: [{ id: 'tool-1' }],
    });

    handleRuntimeEventState(h.set as never, h.get as never, {
      errorMessage: 'Error: Network access denied: 10.0.1.83',
    }, 'error', 'r1');

    const next = h.read();
    expect(next.error).toBeNull();
    expect(next.runError).toBeNull();
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(next.lastUserMessageAt).toBeNull();
    expect(next.streamingMessage).toBeNull();
    expect(next.streamingTools).toEqual([]);
    expect(clearHistoryPoll).toHaveBeenCalledTimes(1);
  });

  it('treats stopReason=error assistant finals as runtime errors', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ sending: true, activeRunId: 'run-err', lastUserMessageAt: 123 });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        id: 'assistant-error',
        content: [],
        stopReason: 'error',
        errorMessage: '404 Resource not found',
      },
    }, 'final', 'run-err');

    const next = h.read();
    expect(next.error).toBe('404 Resource not found');
    expect(next.pendingFinal).toBe(false);
    expect(next.streamingMessage).toBeNull();
    expect(clearHistoryPoll).toHaveBeenCalledTimes(1);
    expect(setErrorRecoveryTimer).not.toHaveBeenCalled();
  });

  it('suppresses outbound media path failures when partial assistant output succeeded', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ sending: true, activeRunId: 'run-partial', lastUserMessageAt: 123 });
    shouldSuppressPartialSuccessRunError.mockReturnValueOnce(true);

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        id: 'assistant-partial',
        content: [{ type: 'text', text: '已发送到您的钉钉（工号：11236149）。' }],
        stopReason: 'error',
        errorMessage: '~\\.openclaw\\media\\outbound\\abc-photo.jpg\\ failed',
      },
    }, 'final', 'run-partial');

    const next = h.read();
    expect(next.runError).toBeNull();
    expect(next.error).toBeNull();
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(clearHistoryPoll).toHaveBeenCalledTimes(1);
  });

  it('does not show Run ended for assistant final errors caused by user denial', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ sending: true, activeRunId: 'run-denied', lastUserMessageAt: 123 });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        id: 'assistant-denied',
        content: [],
        stopReason: 'error',
        errorMessage: 'Error: Network access denied: 10.0.1.83',
      },
    }, 'final', 'run-denied');

    const next = h.read();
    expect(next.error).toBeNull();
    expect(next.runError).toBeNull();
    expect(next.pendingFinal).toBe(false);
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(clearHistoryPoll).toHaveBeenCalledTimes(1);
  });

  it('delta with empty object does not overwrite existing streamingMessage', async () => {
    // Regression test for multi-model fallback: Gateway emits {} during model switch.
    // The existing streamingMessage content must be preserved.
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const existing = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] };
    const h = makeHarness({ streamingMessage: existing });

    handleRuntimeEventState(h.set as never, h.get as never, { message: {} }, 'delta', 'run-x');
    expect(h.read().streamingMessage).toEqual(existing);
  });

  it('delta with role-only object does not overwrite existing streamingMessage', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const existing = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] };
    const h = makeHarness({ streamingMessage: existing });

    handleRuntimeEventState(h.set as never, h.get as never, { message: { role: 'assistant' } }, 'delta', 'run-x');
    expect(h.read().streamingMessage).toEqual(existing);
  });

  it('delta with empty object is accepted when streamingMessage is null (initial state)', async () => {
    // When streaming hasn't started yet, even an empty delta should be let
    // through so the UI can show a typing indicator immediately.
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ streamingMessage: null });

    handleRuntimeEventState(h.set as never, h.get as never, { message: { role: 'assistant' } }, 'delta', 'run-x');
    expect(h.read().streamingMessage).toEqual({ role: 'assistant' });
  });

  it('delta with actual content replaces streamingMessage', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const existing = { role: 'assistant', content: [{ type: 'text', text: 'old' }] };
    const incoming = { role: 'assistant', content: [{ type: 'text', text: 'new' }] };
    const h = makeHarness({ streamingMessage: existing });

    handleRuntimeEventState(h.set as never, h.get as never, { message: incoming }, 'delta', 'run-x');
    expect(h.read().streamingMessage).toEqual(incoming);
  });

  it('normalizes cumulative text and thinking blocks while streaming', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ streamingMessage: null });
    normalizeStreamingMessage.mockReturnValue({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thinking 1 2 3' },
        { type: 'text', text: '1 2 3' },
      ],
    });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thinking 1' },
          { type: 'thinking', thinking: 'thinking 1 2' },
          { type: 'thinking', thinking: 'thinking 1 2 3' },
          { type: 'text', text: '1' },
          { type: 'text', text: '1 2' },
          { type: 'text', text: '1 2 3' },
        ],
      },
    }, 'delta', 'run-stream');

    expect(h.read().streamingMessage).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'thinking 1 2 3' },
        { type: 'text', text: '1 2 3' },
      ],
    });
  });

  it('snapshots normalized streaming content when tool results arrive', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    normalizeStreamingMessage.mockImplementation((message: unknown) => {
      const msg = message as { role: string; id: string; content: unknown[] };
      return {
        ...msg,
        content: [
          { type: 'thinking', thinking: 'thinking 1 2 3' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { filePath: '/tmp/demo.md' } },
          { type: 'text', text: '1 2 3' },
        ],
      };
    });
    snapshotStreamingAssistantMessage.mockImplementation((currentStream: unknown) => {
      const msg = currentStream as { role: string; id: string; content: unknown[] };
      return [{
        ...msg,
        content: [
          { type: 'thinking', thinking: 'thinking 1 2 3' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { filePath: '/tmp/demo.md' } },
          { type: 'text', text: '1 2 3' },
        ],
      }];
    });
    const h = makeHarness({
      streamingMessage: {
        role: 'assistant',
        id: 'streaming-assistant',
        content: [
          { type: 'thinking', thinking: 'thinking 1' },
          { type: 'thinking', thinking: 'thinking 1 2 3' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { filePath: '/tmp/demo.md' } },
          { type: 'text', text: '1' },
          { type: 'text', text: '1 2 3' },
        ],
      },
    });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'read',
        content: [{ type: 'text', text: 'done' }],
      },
    }, 'final', 'run-normalize');

    expect(h.read().messages).toEqual([
      {
        role: 'assistant',
        id: 'streaming-assistant',
        content: [
          { type: 'thinking', thinking: 'thinking 1 2 3' },
          { type: 'tool_use', id: 'call-1', name: 'read', input: { filePath: '/tmp/demo.md' } },
          { type: 'text', text: '1 2 3' },
        ],
      },
    ]);
  });

  it('surfaces backend abort as a run failure instead of silently completing', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    resolveRunFailureErrorMessage.mockReturnValueOnce('Backend agent stopped');
    const h = makeHarness({
      sending: true,
      activeRunId: 'r2',
      streamingText: 'abc',
      pendingFinal: true,
      lastUserMessageAt: 5,
      pendingToolImages: [{ fileName: 'x' }],
    });

    handleRuntimeEventState(h.set as never, h.get as never, {}, 'aborted', 'r2');
    const next = h.read();
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(next.streamingText).toBe('');
    expect(next.pendingFinal).toBe(false);
    expect(next.lastUserMessageAt).toBeNull();
    expect(next.pendingToolImages).toEqual([]);
    expect(next.error).toBe('Backend agent stopped');
    expect(next.runError).toBe('Backend agent stopped');
    expect(next.runAborted).toBe(true);
  });

  it('keeps user-initiated abort silent', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    markAbortedChatRun('r-user');
    const h = makeHarness({
      sending: true,
      activeRunId: 'r-user',
      streamingText: 'abc',
      pendingFinal: true,
      lastUserMessageAt: 5,
      error: 'stale error',
    });

    handleRuntimeEventState(h.set as never, h.get as never, {}, 'aborted', 'r-user');
    const next = h.read();
    expect(next.sending).toBe(false);
    expect(next.error).toBeNull();
    expect(next.runError).toBeNull();
    expect(forgetAbortedChatRun).toHaveBeenCalledWith('r-user');
  });

  it('filters text-block HEARTBEAT_OK deltas before they reach streamingMessage', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({ streamingMessage: null });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
      },
    }, 'delta', 'run-heartbeat');

    expect(h.read().streamingMessage).toBeNull();
  });

  it('filters text-block HEARTBEAT_OK final events without adding to messages', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({
      sending: true,
      activeRunId: 'run-heartbeat',
      messages: [{ role: 'user', content: 'hello', id: 'u1' }],
    });

    handleRuntimeEventState(h.set as never, h.get as never, {
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
        id: 'a-heartbeat',
      },
    }, 'final', 'run-heartbeat');

    expect(h.read().messages).toEqual([{ role: 'user', content: 'hello', id: 'u1' }]);
    expect(h.read().streamingMessage).toBeNull();
    expect(h.read().sending).toBe(false);
  });

  it('filters out NO_REPLY internal message in final event without adding to messages', async () => {
    isInternalMessage.mockReturnValueOnce(true);
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    const h = makeHarness({
      sending: true,
      activeRunId: 'r3',
      messages: [{ role: 'user', content: 'hello', id: 'u1' }],
    });

    handleRuntimeEventState(
      h.set as never,
      h.get as never,
      { message: { role: 'assistant', content: 'NO_REPLY', id: 'a1' } },
      'final',
      'r3',
    );
    const next = h.read();
    // NO_REPLY must not appear in messages
    expect(next.messages).toEqual([{ role: 'user', content: 'hello', id: 'u1' }]);
    expect(next.sending).toBe(false);
    expect(next.activeRunId).toBeNull();
    expect(next.pendingFinal).toBe(false);
    expect(next.streamingText).toBe('');
    expect(next.streamingMessage).toBeNull();
    // Should trigger history reload
    expect(clearHistoryPoll).toHaveBeenCalled();
    expect(next.loadHistory).toHaveBeenCalledWith(true, { force: true });
  });

  it('infers background session from runId when sessionKey is missing', async () => {
    const { handleRuntimeEventState } = await import('@/stores/chat/runtime-event-handlers');
    let state = {
      currentSessionKey: 'session:current',
      sessionStreamingStates: {
        'session:background': {
          activeRunId: 'background-run',
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          runAborted: false,
          sending: false,
          messagesSnapshot: [],
        },
      },
      sending: false,
      activeRunId: 'current-run',
      error: null,
      streamingMessage: null,
      streamingTools: [],
      messages: [],
      pendingToolImages: [],
      pendingFinal: false,
      lastUserMessageAt: null,
      streamingText: '',
      loadHistory: vi.fn(),
    };
    const set = (partial: Partial<typeof state> | ((s: typeof state) => Partial<typeof state>)) => {
      const next = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...next };
    };

    handleRuntimeEventState(
      set as never,
      () => state as any,
      { runId: 'background-run', message: { role: 'assistant', content: 'hello' } },
      'delta',
      'background-run',
    );

    expect(state.sessionStreamingStates['session:background'].streamingMessage).toEqual({ role: 'assistant', content: 'hello' });
  });
});
