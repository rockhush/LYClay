import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { mergeDiscoveredSessionActivity, resolveSessionListActivityMs } from '@/lib/session-sidebar-order';
import { isSubagentSessionKey, pickUserFacingSession } from '@/lib/session-key-utils';
import { useGatewayStore } from '@/stores/gateway';
import { getCanonicalPrefixFromSessions, toMs } from './helpers';
import { DEFAULT_CANONICAL_PREFIX, DEFAULT_SESSION_KEY, type ChatSession } from './types';
import type { ChatGet, ChatSet, SessionHistoryActions } from './store-api';

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

function parseSessionUpdatedAtMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return toMs(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseSessionRecord(record: Record<string, unknown>): ChatSession | null {
  const key = String(record.key || '');
  if (!key || key.includes('__warmup__')) return null;
  const firstUserMessagePreview = record.firstUserMessagePreview
    ? String(record.firstUserMessagePreview)
    : undefined;

  // 过滤掉没有 firstUserMessagePreview 的会话记录
  if (!firstUserMessagePreview) {
    return null;
  }

  return {
    key,
    label: firstUserMessagePreview || (record.label ? String(record.label) : undefined),
    firstUserMessagePreview,
    displayName: record.displayName ? String(record.displayName) : undefined,
    thinkingLevel: record.thinkingLevel ? String(record.thinkingLevel) : undefined,
    model: record.model ? String(record.model) : undefined,
    updatedAt: parseSessionUpdatedAtMs(record.updatedAt),
    lastMessageAt: parseSessionUpdatedAtMs(record.lastMessageAt),
  };
}

async function loadLocalSessionSummaries(agentId = 'main'): Promise<ChatSession[]> {
  const response = await hostApiFetch<{
    success: boolean;
    sessions?: Array<Record<string, unknown>>;
    error?: string;
  }>(`/api/sessions/list-local?agentId=${encodeURIComponent(agentId)}&includePreviews=1`);

  if (!response.success || !Array.isArray(response.sessions)) {
    return [];
  }

  return response.sessions
    .map(parseSessionRecord)
    .filter((session): session is ChatSession => session != null);
}

function mergeSessionSummariesWithLocalPreviews(
  sessions: ChatSession[],
  localSessions: ChatSession[],
): ChatSession[] {
  if (localSessions.length === 0) return sessions;
  const localByKey = new Map(localSessions.map((session) => [session.key, session]));

  return sessions.map((session) => {
    const local = localByKey.get(session.key);
    if (!local) return session;

    const localLabel = local.firstUserMessagePreview || local.label;
    return {
      ...session,
      label: localLabel || session.label,
      firstUserMessagePreview: local.firstUserMessagePreview || session.firstUserMessagePreview,
      updatedAt: session.updatedAt ?? local.updatedAt,
      lastMessageAt: local.lastMessageAt ?? session.lastMessageAt,
    };
  });
}

function getSessionLabelsFromSessions(sessions: ChatSession[]): Record<string, string> {
  return Object.fromEntries(
    sessions
      .filter((session) => session.label)
      .map((session) => [session.key, session.label!]),
  );
}

export function createSessionActions(
  set: ChatSet,
  get: ChatGet,
): Pick<SessionHistoryActions, 'loadSessions' | 'switchSession' | 'newSession' | 'deleteSession' | 'cleanupEmptySession'> {
  return {
    loadSessions: async () => {
      const { gatewayReady } = useGatewayStore.getState().status;

      if (gatewayReady !== true) {
        try {
          const sessions = await loadLocalSessionSummaries('main');

          if (sessions.length > 0) {
            const { currentSessionKey } = get();
            const nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
            
            const discoveredActivity = Object.fromEntries(
              sessions
                .map((session) => {
                  const activity = resolveSessionListActivityMs(session);
                  return activity ? [session.key, activity] as const : null;
                })
                .filter((entry): entry is readonly [string, number] => entry != null),
            );
            const discoveredLabels = getSessionLabelsFromSessions(sessions);

            set((state) => ({
              sessions,
              currentSessionKey: nextSessionKey,
              currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
              sessionLabels: {
                ...state.sessionLabels,
                ...discoveredLabels,
              },
              sessionLastActivity: mergeDiscoveredSessionActivity(
                state.sessionLastActivity,
                discoveredActivity,
              ),
            }));

            return;
          } else {
            console.warn('[Sessions] Local read returned no sessions');
          }
        } catch (err) {
          console.warn('[Sessions] Local read failed with exception:', err);
        }
      }

      try {
        const result = await invokeIpc(
          'gateway:rpc',
          'sessions.list',
          {}
        ) as { success: boolean; result?: Record<string, unknown>; error?: string };

        if (result.success && result.result) {
          const data = result.result;
          const rawSessions = Array.isArray(data.sessions) ? data.sessions : [];
          const gatewaySessions = rawSessions
            .map((s: Record<string, unknown>) => parseSessionRecord(s))
            .filter((session): session is ChatSession => session != null);
          let localSessions: ChatSession[] = [];
          try {
            localSessions = await loadLocalSessionSummaries('main');
          } catch (error) {
            console.warn('[Sessions] Failed to load local session previews for Gateway list:', error);
          }
          const sessions = mergeSessionSummariesWithLocalPreviews(gatewaySessions, localSessions);

          const canonicalBySuffix = new Map<string, string>();
          for (const session of sessions) {
            if (!session.key.startsWith('agent:')) continue;
            const parts = session.key.split(':');
            if (parts.length < 3) continue;
            const suffix = parts.slice(2).join(':');
            if (suffix && !canonicalBySuffix.has(suffix)) {
              canonicalBySuffix.set(suffix, session.key);
            }
          }

          // Deduplicate: if both short and canonical existed, keep canonical only
          const seen = new Set<string>();
          const dedupedSessions = sessions.filter((s) => {
            if (!s.key.startsWith('agent:') && canonicalBySuffix.has(s.key)) return false;
            if (seen.has(s.key)) return false;
            seen.add(s.key);
            return true;
          });

          const { currentSessionKey } = get();
          let nextSessionKey = currentSessionKey || DEFAULT_SESSION_KEY;
          if (!nextSessionKey.startsWith('agent:')) {
            const canonicalMatch = canonicalBySuffix.get(nextSessionKey);
            if (canonicalMatch) {
              nextSessionKey = canonicalMatch;
            }
          }
          if (isSubagentSessionKey(nextSessionKey)) {
            const redirected = pickUserFacingSession(dedupedSessions, currentSessionKey);
            if (redirected) nextSessionKey = redirected.key;
          }
          if (!dedupedSessions.find((s) => s.key === nextSessionKey) && dedupedSessions.length > 0) {
            // Current session not found in the backend list
            const isNewEmptySession = get().messages.length === 0;
            if (!isNewEmptySession) {
              const fallback = pickUserFacingSession(dedupedSessions);
              if (fallback) nextSessionKey = fallback.key;
            }
          }

          const sessionsWithCurrent = !dedupedSessions.find((s) => s.key === nextSessionKey) && nextSessionKey
            ? [
              ...dedupedSessions,
              { key: nextSessionKey, displayName: nextSessionKey },
            ]
            : dedupedSessions;

          const discoveredActivity = Object.fromEntries(
            sessionsWithCurrent
              .map((session) => {
                const activity = resolveSessionListActivityMs(session);
                return activity ? [session.key, activity] as const : null;
              })
              .filter((entry): entry is readonly [string, number] => entry != null),
          );
          const discoveredLabels = getSessionLabelsFromSessions(sessionsWithCurrent);

          set((state) => ({
            sessions: sessionsWithCurrent,
            currentSessionKey: nextSessionKey,
            currentAgentId: getAgentIdFromSessionKey(nextSessionKey),
            sessionLabels: {
              ...state.sessionLabels,
              ...discoveredLabels,
            },
            sessionLastActivity: mergeDiscoveredSessionActivity(
              state.sessionLastActivity,
              discoveredActivity,
            ),
          }));

          if (currentSessionKey !== nextSessionKey) {
            get().loadHistory();
          }
        }
      } catch (err) {
        console.warn('Failed to load sessions:', err);
      }
    },

    // ── Switch session ──

    switchSession: (key: string) => {
      const { currentSessionKey, messages, sessionLastActivity, sessionLabels } = get();
      // Only treat sessions with no history records and no activity timestamp as empty.
      // Relying solely on messages.length is unreliable because switchSession clears
      // the current messages before loadHistory runs, creating a race condition that
      // could cause sessions with real history to be incorrectly removed from the sidebar.
      const leavingEmpty = !currentSessionKey.endsWith(':main')
        && messages.length === 0
        && !sessionLastActivity[currentSessionKey]
        && !sessionLabels[currentSessionKey];
      set((s) => ({
        currentSessionKey: key,
        currentAgentId: getAgentIdFromSessionKey(key),
        messages: [],
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        error: null,
        emptyFinalRecovery: { status: 'idle' },
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        sending: false,
        loading: false,
        ...(leavingEmpty ? {
          sessions: s.sessions.filter((s) => s.key !== currentSessionKey),
          sessionLabels: Object.fromEntries(
            Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
          ),
          sessionLastActivity: Object.fromEntries(
            Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
          ),
        } : {}),
      }));
      get().loadHistory();
    },

    // ── Delete session ──
    //
    // NOTE: The OpenClaw Gateway does NOT expose a sessions.delete (or equivalent)
    // RPC — confirmed by inspecting client.ts, protocol.ts and the full codebase.
    // Deletion is therefore a local-only UI operation: the session is removed from
    // the sidebar list and its labels/activity maps are cleared.  The underlying
    // JSONL history file on disk is intentionally left intact, consistent with the
    // newSession() design that avoids sessions.reset to preserve history.

    deleteSession: async (key: string) => {
      // Soft-delete the session's JSONL transcript on disk.
      // The main process renames <suffix>.jsonl → <suffix>.deleted.jsonl so that
      // sessions.list skips it automatically.
      try {
        const result = await invokeIpc('session:delete', key) as {
          success: boolean;
          error?: string;
        };
        if (!result.success) {
          console.warn(`[deleteSession] IPC reported failure for ${key}:`, result.error);
        }
      } catch (err) {
        console.warn(`[deleteSession] IPC call failed for ${key}:`, err);
      }

      const { currentSessionKey, sessions } = get();
      const remaining = sessions.filter((s) => s.key !== key);

      if (currentSessionKey === key) {
        // Switched away from deleted session — pick the first remaining or create new
        const next = remaining[0];
        set((s) => ({
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
          messages: [],
          streamingText: '',
          streamingMessage: null,
          streamingTools: [],
          activeRunId: null,
          error: null,
          emptyFinalRecovery: { status: 'idle' },
          pendingFinal: false,
          lastUserMessageAt: null,
          pendingToolImages: [],
          currentSessionKey: next?.key ?? DEFAULT_SESSION_KEY,
          currentAgentId: getAgentIdFromSessionKey(next?.key ?? DEFAULT_SESSION_KEY),
        }));
        if (next) {
          get().loadHistory();
        }
      } else {
        set((s) => ({
          sessions: remaining,
          sessionLabels: Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== key)),
          sessionLastActivity: Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== key)),
        }));
      }
    },

    // ── New session ──

    newSession: (agentId?: string) => {
      // Generate a new unique session key and switch to it.
      // NOTE: We intentionally do NOT call sessions.reset on the old session.
      // sessions.reset archives (renames) the session JSONL file, making old
      // conversation history inaccessible when the user switches back to it.
      const { currentSessionKey, messages, sessionLastActivity, sessionLabels } = get();
      // Only treat sessions with no history records and no activity timestamp as empty
      const leavingEmpty = !currentSessionKey.endsWith(':main')
        && messages.length === 0
        && !sessionLastActivity[currentSessionKey]
        && !sessionLabels[currentSessionKey];
      const normalizedAgentId = agentId?.trim();
      const prefix = normalizedAgentId
        ? `agent:${normalizedAgentId}`
        : DEFAULT_CANONICAL_PREFIX;
      const newKey = `${prefix}:session-${Date.now()}`;
      const newSessionEntry: ChatSession = { key: newKey, displayName: newKey };
      set((s) => ({
        currentSessionKey: newKey,
        currentAgentId: getAgentIdFromSessionKey(newKey),
        sessions: [
          ...(leavingEmpty ? s.sessions.filter((sess) => sess.key !== currentSessionKey) : s.sessions),
          newSessionEntry,
        ],
        sessionLabels: leavingEmpty
          ? Object.fromEntries(Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey))
          : s.sessionLabels,
        sessionLastActivity: leavingEmpty
          ? Object.fromEntries(Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey))
          : s.sessionLastActivity,
        messages: [],
        streamingText: '',
        streamingMessage: null,
        streamingTools: [],
        activeRunId: null,
        error: null,
        emptyFinalRecovery: { status: 'idle' },
        pendingFinal: false,
        lastUserMessageAt: null,
        pendingToolImages: [],
        prefilledInput: null,
      }));
    },

    // ── Cleanup empty session on navigate away ──

    cleanupEmptySession: () => {
      const { currentSessionKey, messages, sessionLastActivity, sessionLabels } = get();
      // Only remove non-main sessions that were never used (no messages sent).
      // This mirrors the "leavingEmpty" logic in switchSession so that creating
      // a new session and immediately navigating away doesn't leave a ghost entry
      // in the sidebar.
      // Also check sessionLastActivity and sessionLabels comprehensively to prevent
      // falsely treating sessions with history as empty due to switchSession clearing messages early.
      const isEmptyNonMain = !currentSessionKey.endsWith(':main')
        && messages.length === 0
        && !sessionLastActivity[currentSessionKey]
        && !sessionLabels[currentSessionKey];
      if (!isEmptyNonMain) return;
      set((s) => ({
        sessions: s.sessions.filter((sess) => sess.key !== currentSessionKey),
        sessionLabels: Object.fromEntries(
          Object.entries(s.sessionLabels).filter(([k]) => k !== currentSessionKey),
        ),
        sessionLastActivity: Object.fromEntries(
          Object.entries(s.sessionLastActivity).filter(([k]) => k !== currentSessionKey),
        ),
      }));
    },

    // ── Load chat history ──

  };
}
