import { hostApiFetch } from '@/lib/host-api';
import {
  getSkillDisplayCacheSnapshot,
  loadSkillDisplayCacheLegacy,
} from '@/lib/skill-display-cache';
import type { CachedSkillDisplayMetadata } from '@/lib/skill-display-cache';
import { useChatStore } from '@/stores/chat';
import type { CompressionStateEntry } from '@/stores/chat/types';
import { useWorkspacesStore } from '@/stores/workspaces';
import type { WorkspaceEntry } from '@/types/workspace';

export interface LyclawUiState {
  version: 1;
  updatedAt: number;
  workspaces: {
    currentWorkspaceId: string | null;
    currentWorkspacePath: string | null;
    temporaryWorkspaces: WorkspaceEntry[];
  };
  chat: {
    sessionWorkspaceIds: Record<string, string>;
    customSessionLabels: Record<string, string>;
    sessionPinnedAt: Record<string, number>;
    sessionLastActivity: Record<string, number>;
    sessionCompressionState: Record<string, unknown>;
  };
  skills: {
    cachedDisplayMetadata: Record<string, CachedSkillDisplayMetadata>;
    cachedDisplayVersions?: Record<string, string>;
  };
}

const WORKSPACE_STORAGE_KEYS = [
  'LYClaw-workspaces',
  'ClawX-workspaces',
  'clawx-workspaces',
];

const SESSION_WORKSPACE_KEYS = [
  'LYClaw:chat:session-workspace-ids',
  'ClawX:chat:session-workspace-ids',
  'clawx:chat:session-workspace-ids',
];

const CUSTOM_LABEL_KEYS = [
  'LYClaw:chat:custom-session-labels',
  'ClawX:chat:custom-session-labels',
  'clawx:chat:custom-session-labels',
];

const SESSION_PINNED_AT_KEYS = [
  'LYClaw:chat:session-pinned-at',
  'ClawX:chat:session-pinned-at',
  'clawx:chat:session-pinned-at',
];

const SESSION_LAST_ACTIVITY_KEYS = [
  'LYClaw:chat:session-last-activity',
  'ClawX:chat:session-last-activity',
  'clawx:chat:session-last-activity',
];

function readJsonRecord(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === 'string' && key && typeof value === 'string' && value) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readJsonNumberRecord(raw: string | null): Record<string, number> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === 'string' && key && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function readLocalWorkspaceState(): LyclawUiState['workspaces'] | null {
  for (const key of WORKSPACE_STORAGE_KEYS) {
    const raw = window.localStorage.getItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as {
        state?: {
          currentWorkspaceId?: string | null;
          currentWorkspacePath?: string | null;
          temporaryWorkspaces?: WorkspaceEntry[];
        };
        currentWorkspaceId?: string | null;
        currentWorkspacePath?: string | null;
        temporaryWorkspaces?: WorkspaceEntry[];
      };
      const state = parsed.state ?? parsed;
      return {
        currentWorkspaceId: state.currentWorkspaceId ?? null,
        currentWorkspacePath: state.currentWorkspacePath ?? null,
        temporaryWorkspaces: Array.isArray(state.temporaryWorkspaces) ? state.temporaryWorkspaces : [],
      };
    } catch {
      continue;
    }
  }
  return null;
}

function readLocalChatState(): LyclawUiState['chat'] {
  let sessionWorkspaceIds: Record<string, string> = {};
  let customSessionLabels: Record<string, string> = {};
  let sessionPinnedAt: Record<string, number> = {};
  let sessionLastActivity: Record<string, number> = {};
  for (const key of SESSION_WORKSPACE_KEYS) {
    sessionWorkspaceIds = { ...sessionWorkspaceIds, ...readJsonRecord(window.localStorage.getItem(key)) };
  }
  for (const key of CUSTOM_LABEL_KEYS) {
    customSessionLabels = { ...customSessionLabels, ...readJsonRecord(window.localStorage.getItem(key)) };
  }
  for (const key of SESSION_PINNED_AT_KEYS) {
    sessionPinnedAt = { ...sessionPinnedAt, ...readJsonNumberRecord(window.localStorage.getItem(key)) };
  }
  for (const key of SESSION_LAST_ACTIVITY_KEYS) {
    sessionLastActivity = { ...sessionLastActivity, ...readJsonNumberRecord(window.localStorage.getItem(key)) };
  }
  return { sessionWorkspaceIds, customSessionLabels, sessionPinnedAt, sessionLastActivity, sessionCompressionState: {} };
}

function readLocalSkillsState(): LyclawUiState['skills'] {
  return getSkillDisplayCacheSnapshot();
}

function readLocalUiState(): LyclawUiState {
  const workspaces = readLocalWorkspaceState();
  const chat = readLocalChatState();
  const skills = readLocalSkillsState();
  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces: workspaces ?? {
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      temporaryWorkspaces: [],
    },
    chat,
    skills,
  };
}

function hasLocalWorkspacePersist(): boolean {
  return WORKSPACE_STORAGE_KEYS.some((key) => window.localStorage.getItem(key) != null);
}

function hasLocalChatPersist(): boolean {
  return SESSION_WORKSPACE_KEYS.some((key) => window.localStorage.getItem(key) != null)
    || CUSTOM_LABEL_KEYS.some((key) => window.localStorage.getItem(key) != null)
    || SESSION_PINNED_AT_KEYS.some((key) => window.localStorage.getItem(key) != null)
    || SESSION_LAST_ACTIVITY_KEYS.some((key) => window.localStorage.getItem(key) != null);
}

export function isNonEmptyWorkspaceState(workspaces: LyclawUiState['workspaces']): boolean {
  return workspaces.temporaryWorkspaces.length > 0
    || workspaces.currentWorkspaceId != null
    || (typeof workspaces.currentWorkspacePath === 'string' && workspaces.currentWorkspacePath.trim() !== '');
}

export function isNonEmptyChatState(chat: LyclawUiState['chat']): boolean {
  return Object.keys(chat.sessionWorkspaceIds).length > 0
    || Object.keys(chat.customSessionLabels).length > 0
    || Object.keys(chat.sessionPinnedAt).length > 0
    || Object.keys(chat.sessionLastActivity).length > 0
    || Object.keys(chat.sessionCompressionState).length > 0;
}

export function isNonEmptySkillsState(skills: LyclawUiState['skills']): boolean {
  return Object.keys(skills.cachedDisplayMetadata).length > 0;
}

/** Pure merge used on startup; exported for unit tests. */
export function mergeHydratedUiState(
  disk: LyclawUiState | null,
  local: LyclawUiState,
  options?: {
    preferLocalWorkspaces?: boolean;
    preferLocalChat?: boolean;
  },
): LyclawUiState {
  const preferLocalWorkspaces = options?.preferLocalWorkspaces
    ?? isNonEmptyWorkspaceState(local.workspaces);
  const preferLocalChat = options?.preferLocalChat
    ?? isNonEmptyChatState(local.chat);

  const workspaces = preferLocalWorkspaces
    ? local.workspaces
    : (disk && isNonEmptyWorkspaceState(disk.workspaces)
        ? disk.workspaces
        : local.workspaces);

  const chat = preferLocalChat
    ? local.chat
    : disk
      ? {
          sessionWorkspaceIds: {
            ...disk.chat.sessionWorkspaceIds,
            ...local.chat.sessionWorkspaceIds,
          },
          customSessionLabels: {
            ...disk.chat.customSessionLabels,
            ...local.chat.customSessionLabels,
          },
          sessionPinnedAt: {
            ...disk.chat.sessionPinnedAt,
            ...local.chat.sessionPinnedAt,
          },
          sessionLastActivity: {
            ...disk.chat.sessionLastActivity,
            ...local.chat.sessionLastActivity,
          },
          sessionCompressionState: {
            ...disk.chat.sessionCompressionState,
            ...local.chat.sessionCompressionState,
          },
        }
      : local.chat;

  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces,
    chat,
    skills: disk?.skills && isNonEmptySkillsState(disk.skills)
      ? disk.skills
      : local.skills,
  };
}

function mergeUiState(disk: LyclawUiState | null, local: LyclawUiState): LyclawUiState {
  // After reinstall, zustand persist writes an empty LYClaw-workspaces key before
  // disk hydration finishes. Treat empty local snapshots as "missing" so we keep
  // ~/.openclaw/lyclaw-ui-state.json as the source of truth.
  const preferLocalWorkspaces = hasLocalWorkspacePersist() && isNonEmptyWorkspaceState(local.workspaces);
  const preferLocalChat = hasLocalChatPersist() && isNonEmptyChatState(local.chat);
  return mergeHydratedUiState(disk, local, { preferLocalWorkspaces, preferLocalChat });
}

function applyUiStateToStores(state: LyclawUiState): void {
  useWorkspacesStore.setState((prev) => ({
    ...prev,
    currentWorkspaceId: state.workspaces.currentWorkspaceId,
    currentWorkspacePath: state.workspaces.currentWorkspacePath,
    temporaryWorkspaces: state.workspaces.temporaryWorkspaces,
  }));

  useChatStore.setState((prev) => ({
    ...prev,
    sessionWorkspaceIds: state.chat.sessionWorkspaceIds,
    customSessionLabels: state.chat.customSessionLabels,
    sessionPinnedAt: state.chat.sessionPinnedAt,
    sessionLastActivity: state.chat.sessionLastActivity as Record<string, number>,
    sessionCompressionState: state.chat.sessionCompressionState as Record<string, CompressionStateEntry | null>,
  }));
}

function buildUiStateFromStores(): LyclawUiState {
  const workspaces = useWorkspacesStore.getState();
  const chat = useChatStore.getState();
  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      currentWorkspaceId: workspaces.currentWorkspaceId,
      currentWorkspacePath: workspaces.currentWorkspacePath,
      temporaryWorkspaces: workspaces.temporaryWorkspaces,
    },
    chat: {
      sessionWorkspaceIds: chat.sessionWorkspaceIds,
      customSessionLabels: chat.customSessionLabels,
      sessionPinnedAt: chat.sessionPinnedAt,
      sessionLastActivity: chat.sessionLastActivity,
      sessionCompressionState: chat.sessionCompressionState as unknown as Record<string, unknown>,
    },
    skills: getSkillDisplayCacheSnapshot(),
  };
}

let hydratePromise: Promise<void> | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let syncSubscribed = false;
let lastSyncedPayload = '';

async function persistUiStateToDisk(state: LyclawUiState): Promise<void> {
  const payload = JSON.stringify(state);
  if (payload === lastSyncedPayload) return;
  await hostApiFetch<{ success: boolean }>('/api/ui-state', {
    method: 'PUT',
    body: JSON.stringify(state),
  });
  lastSyncedPayload = payload;
}

export function scheduleUiStateSync(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void flushUiStateSync().catch((error) => {
      console.warn('[ui-state] Failed to persist UI metadata:', error);
    });
  }, 400);
}

export async function flushUiStateSync(): Promise<void> {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  await persistUiStateToDisk(buildUiStateFromStores());
}

export function startUiStateSync(): void {
  if (syncSubscribed) return;
  syncSubscribed = true;

  useWorkspacesStore.subscribe((state, prev) => {
    if (
      state.currentWorkspaceId !== prev.currentWorkspaceId
      || state.currentWorkspacePath !== prev.currentWorkspacePath
      || state.temporaryWorkspaces !== prev.temporaryWorkspaces
    ) {
      scheduleUiStateSync();
    }
  });

  useChatStore.subscribe((state, prev) => {
    if (
      state.sessionWorkspaceIds !== prev.sessionWorkspaceIds
      || state.customSessionLabels !== prev.customSessionLabels
      || state.sessionPinnedAt !== prev.sessionPinnedAt
      || state.sessionLastActivity !== prev.sessionLastActivity
      || state.sessionCompressionState !== prev.sessionCompressionState
    ) {
      scheduleUiStateSync();
    }
  });
}

export async function hydrateUiStateFromDisk(): Promise<void> {
  if (hydratePromise) return hydratePromise;

  hydratePromise = (async () => {
    const local = readLocalUiState();
    let disk: LyclawUiState | null = null;
    try {
      const result = await hostApiFetch<{ success: boolean; state?: LyclawUiState }>('/api/ui-state');
      if (result.success && result.state) {
        disk = result.state;
      }
    } catch (error) {
      console.warn('[ui-state] Failed to load UI metadata from disk:', error);
    }

    const merged = mergeUiState(disk, local);
    loadSkillDisplayCacheLegacy(merged.skills.cachedDisplayMetadata, merged.skills.cachedDisplayVersions);
    applyUiStateToStores(merged);

    startUiStateSync();

    try {
      await flushUiStateSync();
    } catch (error) {
      console.warn('[ui-state] Failed to sync UI metadata to disk after hydrate:', error);
    }
  })();

  return hydratePromise;
}
