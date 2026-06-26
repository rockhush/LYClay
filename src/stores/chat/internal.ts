import { DEFAULT_SESSION_KEY, type ChatState } from './types';
import { createRuntimeActions } from './runtime-actions';
import { createSessionHistoryActions } from './session-history-actions';
import type { ChatGet, ChatSet } from './store-api';

const REASONING_MODE_STORAGE_KEY = 'LYClaw:chat:reasoning-mode';

function loadStoredReasoningMode(): ChatState['reasoningMode'] {
  try {
    const stored = window.localStorage.getItem(REASONING_MODE_STORAGE_KEY);
    if (stored === 'fast' || stored === 'thinking') {
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
  | 'runError'
  | 'emptyFinalRecovery'
  | 'securityCancelNotice'
  | 'prefilledInput'
  | 'sending'
  | 'activeRunId'
  | 'activeTool'
  | 'streamingText'
  | 'streamingMessage'
  | 'streamingTools'
  | 'pendingFinal'
  | 'lastUserMessageAt'
  | 'pendingToolImages'
  | 'runawayToolObservation'
  | 'sessionRunawayToolObservations'
  | 'runAborted'
  | 'sessions'
  | 'currentSessionKey'
  | 'currentAgentId'
  | 'sessionLabels'
  | 'sessionCompressionState'
  | 'contextCompressionStatus'
  | 'customSessionLabels'
  | 'sessionLastActivity'
  | 'sessionWorkspaceIds'
  | 'sessionPinnedAt'
  | 'sessionStreamingStates'
  | 'thinkingLevel'
  | 'reasoningMode'
> = {
  messages: [],
  loading: false,
  error: null,
  runError: null,
  emptyFinalRecovery: { status: 'idle' },
  securityCancelNotice: null,
  prefilledInput: null,

  sending: false,
  aborting: false,
  activeRunId: null,
  activeTool: null,
  streamingText: '',
  streamingMessage: null,
  streamingTools: [],
  pendingFinal: false,
  lastUserMessageAt: null,
  pendingToolImages: [],
  runawayToolObservation: null,
  sessionRunawayToolObservations: {},
  runAborted: false,

  sessions: [],
  currentSessionKey: DEFAULT_SESSION_KEY,
  currentAgentId: 'main',
  sessionLabels: {},
  contextCompressionStatus: null,
  customSessionLabels: {},
  sessionLastActivity: {},
  sessionWorkspaceIds: {},
  sessionPinnedAt: {},
  sessionStreamingStates: {},
  sessionCompressionState: {},

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
  | 'recoverCurrentSession'
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
