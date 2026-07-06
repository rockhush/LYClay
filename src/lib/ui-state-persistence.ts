import { hostApiFetch } from '@/lib/host-api';
import {
  getSkillDisplayCacheSnapshot,
  loadSkillDisplayCacheLegacy,
} from '@/lib/skill-display-cache';
import type { CachedSkillDisplayMetadata } from '@/lib/skill-display-cache';
import {
  getDigitalEmployeeDisplayCacheSnapshot,
  loadDigitalEmployeeDisplayCache,
} from '@/lib/digital-employee-display-cache';
import type { CachedDigitalEmployeeDisplayMetadata } from '@/lib/digital-employee-display-cache';
import type { CompressionStateEntry } from '@/stores/chat/types';
import type { WorkspaceEntry } from '@/types/workspace';

type StoreModule = typeof import('@/stores/workspaces');
type ChatStoreModule = typeof import('@/stores/chat');

async function loadStoreModules(): Promise<{
  useWorkspacesStore: StoreModule['useWorkspacesStore'];
  useChatStore: ChatStoreModule['useChatStore'];
}> {
  const [workspaces, chat] = await Promise.all([
    import('@/stores/workspaces'),
    import('@/stores/chat'),
  ]);
  return {
    useWorkspacesStore: workspaces.useWorkspacesStore,
    useChatStore: chat.useChatStore,
  };
}

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
    sessionLabels: Record<string, string>;
    sessionPinnedAt: Record<string, number>;
    sessionLastActivity: Record<string, number>;
    sessionCompressionState: Record<string, unknown>;
  };
  skills: {
    cachedDisplayMetadata: Record<string, CachedSkillDisplayMetadata>;
    cachedDisplayVersions?: Record<string, string>;
  };
  digitalEmployees: {
    cachedDisplayMetadata: Record<string, CachedDigitalEmployeeDisplayMetadata>;
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
  return { sessionWorkspaceIds, customSessionLabels, sessionPinnedAt, sessionLastActivity, sessionLabels: {}, sessionCompressionState: {} };
}

function readLocalDigitalEmployeesState(): LyclawUiState['digitalEmployees'] {
  return getDigitalEmployeeDisplayCacheSnapshot();
}

function readLocalSkillsState(): LyclawUiState['skills'] {
  return getSkillDisplayCacheSnapshot();
}

function readLocalUiState(): LyclawUiState {
  const workspaces = readLocalWorkspaceState();
  const chat = readLocalChatState();
  const skills = readLocalSkillsState();
  const digitalEmployees = readLocalDigitalEmployeesState();
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
    digitalEmployees,
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
    || Object.keys(chat.sessionLabels).length > 0
    || Object.keys(chat.sessionPinnedAt).length > 0
    || Object.keys(chat.sessionLastActivity).length > 0
    || Object.keys(chat.sessionCompressionState).length > 0;
}

export function isNonEmptySkillsState(skills: LyclawUiState['skills']): boolean {
  return Object.keys(skills.cachedDisplayMetadata).length > 0;
}

export function isNonEmptyDigitalEmployeesState(
  digitalEmployees: LyclawUiState['digitalEmployees'],
): boolean {
  return Object.keys(digitalEmployees.cachedDisplayMetadata).length > 0;
}

function mergeChatFields(
  diskChat: LyclawUiState['chat'] | undefined,
  localChat: LyclawUiState['chat'],
): LyclawUiState['chat'] {
  return {
    sessionWorkspaceIds: {
      ...diskChat?.sessionWorkspaceIds,
      ...localChat.sessionWorkspaceIds,
    },
    customSessionLabels: {
      ...diskChat?.customSessionLabels,
      ...localChat.customSessionLabels,
    },
    sessionLabels: {
      ...diskChat?.sessionLabels,
      ...localChat.sessionLabels,
    },
    sessionPinnedAt: {
      ...diskChat?.sessionPinnedAt,
      ...localChat.sessionPinnedAt,
    },
    sessionLastActivity: {
      ...diskChat?.sessionLastActivity,
      ...localChat.sessionLastActivity,
    },
    sessionCompressionState: {
      ...diskChat?.sessionCompressionState,
      ...localChat.sessionCompressionState,
    },
  };
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

  const workspaces = preferLocalWorkspaces
    ? local.workspaces
    : (disk && isNonEmptyWorkspaceState(disk.workspaces)
        ? disk.workspaces
        : local.workspaces);

  const chat = disk
    ? mergeChatFields(disk.chat, local.chat)
    : local.chat;

  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces,
    chat,
    skills: disk?.skills && isNonEmptySkillsState(disk.skills)
      ? disk.skills
      : local.skills,
    digitalEmployees: disk?.digitalEmployees && isNonEmptyDigitalEmployeesState(disk.digitalEmployees)
      ? disk.digitalEmployees
      : local.digitalEmployees,
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

function applyUiStateToStores(
  state: LyclawUiState,
  stores: Pick<Awaited<ReturnType<typeof loadStoreModules>>, 'useWorkspacesStore' | 'useChatStore'>,
): void {
  const { useWorkspacesStore, useChatStore } = stores;
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
    sessionLabels: {
      ...prev.sessionLabels,
      ...state.chat.sessionLabels,
    },
    sessionPinnedAt: state.chat.sessionPinnedAt,
    sessionLastActivity: state.chat.sessionLastActivity as Record<string, number>,
    sessionCompressionState: state.chat.sessionCompressionState as Record<string, CompressionStateEntry | null>,
  }));
}

async function buildUiStateFromStores(): Promise<LyclawUiState> {
  const { useWorkspacesStore, useChatStore } = await loadStoreModules();
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
      sessionLabels: chat.sessionLabels,
      sessionPinnedAt: chat.sessionPinnedAt,
      sessionLastActivity: chat.sessionLastActivity,
      sessionCompressionState: chat.sessionCompressionState as unknown as Record<string, unknown>,
    },
    skills: getSkillDisplayCacheSnapshot(),
    digitalEmployees: getDigitalEmployeeDisplayCacheSnapshot(),
  };
}

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
  await persistUiStateToDisk(await buildUiStateFromStores());
}

export function startUiStateSync(): void {
  if (syncSubscribed) return;
  syncSubscribed = true;

  void loadStoreModules().then(({ useWorkspacesStore, useChatStore }) => {
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
        || state.sessionLabels !== prev.sessionLabels
        || state.sessionPinnedAt !== prev.sessionPinnedAt
        || state.sessionLastActivity !== prev.sessionLastActivity
        || state.sessionCompressionState !== prev.sessionCompressionState
      ) {
        scheduleUiStateSync();
      }
    });
  }).catch((error) => {
    console.warn('[ui-state] Failed to subscribe store sync listeners:', error);
  });
}

type HydrateUiStateFn = typeof hydrateUiStateFromDisk & {
  __hydratePromise?: Promise<void> | null;
};

export async function hydrateUiStateFromDisk(): Promise<void> {
  const hydrateFn = hydrateUiStateFromDisk as HydrateUiStateFn;
  if (hydrateFn.__hydratePromise) return hydrateFn.__hydratePromise;

  hydrateFn.__hydratePromise = (async () => {
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
    loadDigitalEmployeeDisplayCache(merged.digitalEmployees);
    const stores = await loadStoreModules();
    applyUiStateToStores(merged, stores);

    startUiStateSync();

    try {
      await flushUiStateSync();
    } catch (error) {
      console.warn('[ui-state] Failed to sync UI metadata to disk after hydrate:', error);
    }
  })();

  return hydrateFn.__hydratePromise;
}

/** Await durable UI metadata before rebuilding the session sidebar on cold start. */
export const ensureUiStateHydrated = hydrateUiStateFromDisk;
