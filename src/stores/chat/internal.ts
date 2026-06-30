import { DEFAULT_SESSION_KEY, type ChatState, type ReasoningMode } from './types';
import { createRuntimeActions } from './runtime-actions';
import { createSessionHistoryActions } from './session-history-actions';
import type { ChatGet, ChatSet } from './store-api';

const REASONING_MODE_STORAGE_KEY = 'LYClaw:chat:reasoning-mode';
const SESSION_REASONING_MODES_STORAGE_KEY = 'LYClaw:chat:session-reasoning-modes';

function isReasoningMode(value: unknown): value is ReasoningMode {
  return value === 'fast' || value === 'thinking';
}

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

function loadSessionReasoningModesFromStorage(): Record<string, ChatState['reasoningMode']> {
  try {
    const raw = window.localStorage.getItem(SESSION_REASONING_MODES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, ChatState['reasoningMode']> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && k && isReasoningMode(v)) {
        out[k] = v;
      }
    }
    return out;
  } catch {
    return {};
  }
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
  | 'aborting'
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
  | 'sessionReasoningModes'
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
  sessionReasoningModes: loadSessionReasoningModesFromStorage(),

  thinkingLevel: null,
  reasoningMode: loadSessionReasoningModesFromStorage()[DEFAULT_SESSION_KEY] ?? loadStoredReasoningMode(),
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
