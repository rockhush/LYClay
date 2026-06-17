/**
 * Durable UI metadata stored alongside OpenClaw data (~/.openclaw).
 * Survives app reinstall/upgrade when the OpenClaw folder is preserved.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getOpenClawConfigDir } from './paths';
import { logger } from './logger';

export interface UiStateWorkspaceEntry {
  id: string;
  name: string;
  agentId: string;
  agentName: string;
  path: string;
  createdAt: number;
  lastAccessedAt: number;
}

export interface CachedSkillDisplayMetadata {
  version?: string;
  name?: string;
  author?: string;
  description?: string;
  update_time?: string;
}

export interface CachedDigitalEmployeeDisplayMetadata {
  version?: string;
  name?: string;
  author?: string;
  description?: string;
  updateTime?: string;
  tags?: string[];
}

export interface LyclawUiState {
  version: 1;
  updatedAt: number;
  workspaces: {
    currentWorkspaceId: string | null;
    currentWorkspacePath: string | null;
    temporaryWorkspaces: UiStateWorkspaceEntry[];
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
  };
  digitalEmployees: {
    cachedDisplayMetadata: Record<string, CachedDigitalEmployeeDisplayMetadata>;
  };
}

const UI_STATE_FILE = 'lyclaw-ui-state.json';

function getUiStatePath(): string {
  return join(getOpenClawConfigDir(), UI_STATE_FILE);
}

export function createEmptyUiState(): LyclawUiState {
  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      temporaryWorkspaces: [],
    },
    chat: {
      sessionWorkspaceIds: {},
      customSessionLabels: {},
      sessionPinnedAt: {},
      sessionLastActivity: {},
      sessionCompressionState: {},
    },
    skills: {
      cachedDisplayMetadata: {},
    },
    digitalEmployees: {
      cachedDisplayMetadata: {},
    },
  };
}

function sanitizeCachedDigitalEmployeeDisplayMetadata(
  input: unknown,
): CachedDigitalEmployeeDisplayMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const metadata: CachedDigitalEmployeeDisplayMetadata = {};
  if (typeof raw.version === 'string' && raw.version.trim()) metadata.version = raw.version.trim();
  if (typeof raw.name === 'string' && raw.name.trim()) metadata.name = raw.name.trim();
  if (typeof raw.author === 'string' && raw.author.trim()) metadata.author = raw.author.trim();
  if (typeof raw.description === 'string' && raw.description.trim()) {
    metadata.description = raw.description.trim();
  }
  if (typeof raw.updateTime === 'string' && raw.updateTime.trim()) {
    metadata.updateTime = raw.updateTime.trim();
  }
  if (Array.isArray(raw.tags)) {
    const tags = raw.tags
      .filter((tag): tag is string => typeof tag === 'string')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (tags.length > 0) metadata.tags = tags;
  }
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function sanitizeCachedDigitalEmployeeDisplayMetadataRecord(
  input: unknown,
): Record<string, CachedDigitalEmployeeDisplayMetadata> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, CachedDigitalEmployeeDisplayMetadata> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key) continue;
    const metadata = sanitizeCachedDigitalEmployeeDisplayMetadata(value);
    if (metadata) out[key] = metadata;
  }
  return out;
}

function sanitizeCachedSkillDisplayMetadata(input: unknown): CachedSkillDisplayMetadata | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const metadata: CachedSkillDisplayMetadata = {};
  if (typeof raw.version === 'string' && raw.version.trim()) metadata.version = raw.version.trim();
  if (typeof raw.name === 'string' && raw.name.trim()) metadata.name = raw.name.trim();
  if (typeof raw.author === 'string' && raw.author.trim()) metadata.author = raw.author.trim();
  if (typeof raw.description === 'string' && raw.description.trim()) metadata.description = raw.description.trim();
  if (typeof raw.update_time === 'string' && raw.update_time.trim()) metadata.update_time = raw.update_time.trim();
  return Object.keys(metadata).length > 0 ? metadata : null;
}

function sanitizeCachedSkillDisplayMetadataRecord(input: unknown): Record<string, CachedSkillDisplayMetadata> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, CachedSkillDisplayMetadata> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key !== 'string' || !key) continue;
    const metadata = sanitizeCachedSkillDisplayMetadata(value);
    if (metadata) out[key] = metadata;
  }
  return out;
}

function migrateLegacySkillVersionCache(
  metadata: Record<string, CachedSkillDisplayMetadata>,
  legacyVersions: Record<string, string>,
): Record<string, CachedSkillDisplayMetadata> {
  const next = { ...metadata };
  for (const [key, version] of Object.entries(legacyVersions)) {
    if (!key.trim() || !version.trim()) continue;
    if (next[key]?.version) continue;
    next[key] = { ...(next[key] ?? {}), version: version.trim() };
  }
  return next;
}

function sanitizeStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === 'string' && key && typeof value === 'string' && value) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeNumberRecord(input: unknown): Record<string, number> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === 'string' && key && typeof value === 'number' && Number.isFinite(value) && value > 0) {
      out[key] = value;
    }
  }
  return out;
}

function sanitizeCompressionStateRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof key === 'string' && key && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = value;
    }
  }
  return out;
}
function sanitizeWorkspaceEntry(raw: unknown): UiStateWorkspaceEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entry = raw as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !entry.id) return null;
  if (typeof entry.name !== 'string' || !entry.name) return null;
  if (typeof entry.path !== 'string' || !entry.path) return null;
  const createdAt = typeof entry.createdAt === 'number' ? entry.createdAt : Date.now();
  const lastAccessedAt = typeof entry.lastAccessedAt === 'number' ? entry.lastAccessedAt : createdAt;
  return {
    id: entry.id,
    name: entry.name,
    agentId: typeof entry.agentId === 'string' ? entry.agentId : 'temp',
    agentName: typeof entry.agentName === 'string' ? entry.agentName : entry.name,
    path: entry.path,
    createdAt,
    lastAccessedAt,
  };
}

function sanitizeWorkspaceEntries(input: unknown): UiStateWorkspaceEntry[] {
  if (!Array.isArray(input)) return [];
  return input.map(sanitizeWorkspaceEntry).filter((entry): entry is UiStateWorkspaceEntry => entry != null);
}

export function normalizeUiState(raw: unknown): LyclawUiState {
  const empty = createEmptyUiState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const data = raw as Record<string, unknown>;
  const workspacesRaw = data.workspaces;
  const chatRaw = data.chat;
  const workspacesObj = workspacesRaw && typeof workspacesRaw === 'object' && !Array.isArray(workspacesRaw)
    ? workspacesRaw as Record<string, unknown>
    : {};
  const chatObj = chatRaw && typeof chatRaw === 'object' && !Array.isArray(chatRaw)
    ? chatRaw as Record<string, unknown>
    : {};
  const skillsRaw = data.skills;
  const skillsObj = skillsRaw && typeof skillsRaw === 'object' && !Array.isArray(skillsRaw)
    ? skillsRaw as Record<string, unknown>
    : {};
  const digitalEmployeesRaw = data.digitalEmployees;
  const digitalEmployeesObj = digitalEmployeesRaw
    && typeof digitalEmployeesRaw === 'object'
    && !Array.isArray(digitalEmployeesRaw)
    ? digitalEmployeesRaw as Record<string, unknown>
    : {};

  return {
    version: 1,
    updatedAt: typeof data.updatedAt === 'number' ? data.updatedAt : Date.now(),
    workspaces: {
      currentWorkspaceId: typeof workspacesObj.currentWorkspaceId === 'string'
        ? workspacesObj.currentWorkspaceId
        : null,
      currentWorkspacePath: typeof workspacesObj.currentWorkspacePath === 'string'
        ? workspacesObj.currentWorkspacePath
        : null,
      temporaryWorkspaces: sanitizeWorkspaceEntries(workspacesObj.temporaryWorkspaces),
    },
    chat: {
      sessionWorkspaceIds: sanitizeStringRecord(chatObj.sessionWorkspaceIds),
      customSessionLabels: sanitizeStringRecord(chatObj.customSessionLabels),
      sessionPinnedAt: sanitizeNumberRecord(chatObj.sessionPinnedAt),
      sessionLastActivity: sanitizeNumberRecord(chatObj.sessionLastActivity),
      sessionCompressionState: sanitizeCompressionStateRecord(chatObj.sessionCompressionState),
    },
    skills: {
      cachedDisplayMetadata: migrateLegacySkillVersionCache(
        sanitizeCachedSkillDisplayMetadataRecord(skillsObj.cachedDisplayMetadata),
        sanitizeStringRecord(skillsObj.cachedDisplayVersions),
      ),
    },
    digitalEmployees: {
      cachedDisplayMetadata: sanitizeCachedDigitalEmployeeDisplayMetadataRecord(
        digitalEmployeesObj.cachedDisplayMetadata,
      ),
    },
  };
}

export function readUiState(): LyclawUiState {
  const path = getUiStatePath();
  if (!existsSync(path)) return createEmptyUiState();
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return normalizeUiState(raw);
  } catch (error) {
    logger.warn('[ui-state] Failed to read UI state, using defaults', { error: String(error) });
    return createEmptyUiState();
  }
}

export function writeUiState(next: LyclawUiState): LyclawUiState {
  const dir = getOpenClawConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const normalized: LyclawUiState = {
    ...normalizeUiState(next),
    version: 1,
    updatedAt: Date.now(),
  };
  const path = getUiStatePath();
  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, JSON.stringify(normalized, null, 2), 'utf8');
  if (existsSync(path)) {
    renameSync(tempPath, path);
  } else {
    renameSync(tempPath, path);
  }
  return normalized;
}

export function mergeUiState(base: LyclawUiState, patch: Partial<LyclawUiState>): LyclawUiState {
  const normalizedPatch = normalizeUiState({ ...base, ...patch, version: 1 });
  const replaceWorkspaces = patch.workspaces != null;
  const replaceChat = patch.chat != null;
  const replaceSkills = patch.skills != null;
  const replaceDigitalEmployees = patch.digitalEmployees != null;

  const temporaryWorkspaces = replaceWorkspaces
    ? normalizedPatch.workspaces.temporaryWorkspaces
    : normalizedPatch.workspaces.temporaryWorkspaces.length > 0
      ? normalizedPatch.workspaces.temporaryWorkspaces
      : base.workspaces.temporaryWorkspaces;

  return {
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      currentWorkspaceId: replaceWorkspaces
        ? normalizedPatch.workspaces.currentWorkspaceId
        : normalizedPatch.workspaces.currentWorkspaceId ?? base.workspaces.currentWorkspaceId,
      currentWorkspacePath: replaceWorkspaces
        ? normalizedPatch.workspaces.currentWorkspacePath
        : normalizedPatch.workspaces.currentWorkspacePath ?? base.workspaces.currentWorkspacePath,
      temporaryWorkspaces: [...temporaryWorkspaces].sort((a, b) => b.lastAccessedAt - a.lastAccessedAt),
    },
    chat: {
      sessionWorkspaceIds: replaceChat
        ? normalizedPatch.chat.sessionWorkspaceIds
        : { ...base.chat.sessionWorkspaceIds, ...normalizedPatch.chat.sessionWorkspaceIds },
      customSessionLabels: replaceChat
        ? normalizedPatch.chat.customSessionLabels
        : { ...base.chat.customSessionLabels, ...normalizedPatch.chat.customSessionLabels },
      sessionPinnedAt: replaceChat
        ? normalizedPatch.chat.sessionPinnedAt
        : { ...base.chat.sessionPinnedAt, ...normalizedPatch.chat.sessionPinnedAt },
      sessionLastActivity: replaceChat
        ? normalizedPatch.chat.sessionLastActivity
        : { ...base.chat.sessionLastActivity, ...normalizedPatch.chat.sessionLastActivity },
      sessionCompressionState: replaceChat
        ? normalizedPatch.chat.sessionCompressionState
        : { ...base.chat.sessionCompressionState, ...normalizedPatch.chat.sessionCompressionState },
    },
    skills: {
      cachedDisplayMetadata: replaceSkills
        ? normalizedPatch.skills.cachedDisplayMetadata
        : { ...base.skills.cachedDisplayMetadata, ...normalizedPatch.skills.cachedDisplayMetadata },
    },
    digitalEmployees: {
      cachedDisplayMetadata: replaceDigitalEmployees
        ? normalizedPatch.digitalEmployees.cachedDisplayMetadata
        : {
            ...base.digitalEmployees.cachedDisplayMetadata,
            ...normalizedPatch.digitalEmployees.cachedDisplayMetadata,
          },
    },
  };
}
