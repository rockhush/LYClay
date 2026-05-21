import { DEFAULT_SESSION_KEY, type ChatState } from './types';
import { createRuntimeActions } from './runtime-actions';
import { createSessionHistoryActions } from './session-history-actions';
import type { ChatGet, ChatSet } from './store-api';

const REASONING_MODE_STORAGE_KEY = 'LYClaw:chat:reasoning-mode';

function loadStoredReasoningMode(): ChatState['reasoningMode'] {
  try {
    const stored = window.localStorage.getItem(REASONING_MODE_STORAGE_KEY);
    if (stored === 'fast' || stored === 'thinking' || stored === 'expert') {
      return stored;
    }
  } catch {
    // Keep default when storage is unavailable.
  }
  return 'fast';
}

export const initialChatState: Pick<
  ChatState,
  | 'messages'
  | 'loading'
  | 'error'
  | 'sending'
  | 'activeRunId'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'pendingToolImages'
  | 'sessions'
  | 'currentSessionKey'
  | 'currentAgentId'
  | 'sessionLabels'
  | 'sessionLastActivity'
  | 'thinkingLevel'
  | 'reasoningMode'
> = {
  messages: [],
  loading: false,
  error: null,

  sending: false,
  aborting: false,
  activeRunId: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],

  sessions: [],
  currentSessionKey: DEFAULT_SESSION_KEY,
  currentAgentId: 'main',
  sessionLabels: {},
  sessionLastActivity: {},

  thinkingLevel: null,
  reasoningMode: loadStoredReasoningMode(),
};

export function createChatActions(
  set: ChatSet,
  get: ChatGet,
): Pick<
  ChatState,
  | 'loadSessions'
  | 'switchSession'
  | 'newSession'
  | 'deleteSession'
  | 'cleanupEmptySession'
  | 'loadHistory'
  | 'sendMessage'
  | 'abortRun'
  | 'setReasoningMode'
  | 'handleChatEvent'
  | 'refresh'
  | 'clearError'
> {
  return {
    ...createSessionHistoryActions(set, get),
    ...createRuntimeActions(set, get),
  };
}
