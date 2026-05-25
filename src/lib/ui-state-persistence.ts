import { hostApiFetch } from '@/lib/host-api';
import { useChatStore } from '@/stores/chat';
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
  for (const key of SESSION_WORKSPACE_KEYS) {
    sessionWorkspaceIds = { ...sessionWorkspaceIds, ...readJsonRecord(window.localStorage.getItem(key)) };
  }
  for (const key of CUSTOM_LABEL_KEYS) {
    customSessionLabels = { ...customSessionLabels, ...readJsonRecord(window.localStorage.getItem(key)) };
  }
  return { sessionWorkspaceIds, customSessionLabels };
}

function readLocalUiState(): LyclawUiState {
  const workspaces = readLocalWorkspaceState();
  const chat = readLocalChatState();
  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces: workspaces ?? {
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      temporaryWorkspaces: [],
    },
    chat,
  };
}

function countUiState(state: LyclawUiState): number {
  return state.workspaces.temporaryWorkspaces.length
    + Object.keys(state.chat.sessionWorkspaceIds).length
    + Object.keys(state.chat.customSessionLabels).length
    + (state.workspaces.currentWorkspaceId ? 1 : 0);
}

function mergeUiState(disk: LyclawUiState | null, local: LyclawUiState): LyclawUiState {
  const base = disk ?? local;
  const workspaceMap = new Map<string, WorkspaceEntry>();
  for (const entry of base.workspaces.temporaryWorkspaces) workspaceMap.set(entry.id, entry);
  for (const entry of local.workspaces.temporaryWorkspaces) workspaceMap.set(entry.id, entry);

  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      currentWorkspaceId: local.workspaces.currentWorkspaceId ?? base.workspaces.currentWorkspaceId,
      currentWorkspacePath: local.workspaces.currentWorkspacePath ?? base.workspaces.currentWorkspacePath,
      temporaryWorkspaces: [...workspaceMap.values()].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt),
    },
    chat: {
      sessionWorkspaceIds: { ...base.chat.sessionWorkspaceIds, ...local.chat.sessionWorkspaceIds },
      customSessionLabels: { ...base.chat.customSessionLabels, ...local.chat.customSessionLabels },
    },
  };
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
    },
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
    void persistUiStateToDisk(buildUiStateFromStores()).catch((error) => {
      console.warn('[ui-state] Failed to persist UI metadata:', error);
    });
  }, 400);
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
    applyUiStateToStores(merged);

    const shouldWriteDisk = !disk || countUiState(merged) > countUiState(disk);
    if (shouldWriteDisk && countUiState(merged) > 0) {
      try {
        await persistUiStateToDisk(merged);
      } catch (error) {
        console.warn('[ui-state] Failed to migrate UI metadata to disk:', error);
      }
    }

    startUiStateSync();
  })();

  return hydratePromise;
}
