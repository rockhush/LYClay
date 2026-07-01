/**
 * OpenClaw 6.x agent auth persistence (SQLite).
 * Runtime reads credentials from ~/.openclaw/agents/<id>/agent/openclaw-agent.sqlite,
 * not auth-profiles.json. LYClaw must write the same store shape.
 */
import { chmodSync, existsSync, mkdirSync } from 'fs';
import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { DatabaseSync } from 'node:sqlite';

const PRIMARY_ROW_KEY = 'primary';
const AUTH_PROFILE_FILENAME = 'auth-profiles.json';
const AUTH_STATE_FILENAME = 'auth-state.json';
const AUTH_STORE_VERSION = 1;
const OPENCLAW_AGENT_SCHEMA_VERSION = 1;
const OPENCLAW_AGENT_DB_DIR_MODE = 0o700;
const OPENCLAW_AGENT_DB_FILE_MODE = 0o600;

const OPENCLAW_AGENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS schema_meta (
  meta_key TEXT NOT NULL PRIMARY KEY,
  role TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  agent_id TEXT,
  app_version TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS cache_entries (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT,
  blob BLOB,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_expiry
  ON cache_entries(scope, expires_at, key)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_cache_updated
  ON cache_entries(scope, updated_at DESC, key);

CREATE TABLE IF NOT EXISTS auth_profile_store (
  store_key TEXT NOT NULL PRIMARY KEY,
  store_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_profile_state (
  state_key TEXT NOT NULL PRIMARY KEY,
  state_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

export interface AuthProfileEntry {
  type: 'api_key';
  provider: string;
  key: string;
}

export interface OAuthProfileEntry {
  type: 'oauth';
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  email?: string;
  projectId?: string;
}

export interface AuthProfilesStore {
  version: number;
  profiles: Record<string, AuthProfileEntry | OAuthProfileEntry>;
  order?: Record<string, string[]>;
  lastGood?: Record<string, string>;
  usageStats?: Record<string, unknown>;
}

function getAgentDir(agentId: string): string {
  return join(homedir(), '.openclaw', 'agents', agentId, 'agent');
}

export function getAgentAuthSqlitePath(agentId: string): string {
  return join(getAgentDir(agentId), 'openclaw-agent.sqlite');
}

function getAuthProfilesJsonPath(agentId: string): string {
  return join(getAgentDir(agentId), AUTH_PROFILE_FILENAME);
}

function getAuthStateJsonPath(agentId: string): string {
  return join(getAgentDir(agentId), AUTH_STATE_FILENAME);
}

function parseJsonCell(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function ensureAgentDatabase(agentId: string): DatabaseSync {
  const agentDir = getAgentDir(agentId);
  mkdirSync(agentDir, { recursive: true, mode: OPENCLAW_AGENT_DB_DIR_MODE });
  const pathname = getAgentAuthSqlitePath(agentId);
  const db = new DatabaseSync(pathname);
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(OPENCLAW_AGENT_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION};`);
  const now = Date.now();
  db.prepare(`
    INSERT INTO schema_meta (meta_key, role, schema_version, agent_id, app_version, created_at, updated_at)
    VALUES (?, 'agent', ?, ?, NULL, ?, ?)
    ON CONFLICT(meta_key) DO UPDATE SET
      role = excluded.role,
      schema_version = excluded.schema_version,
      agent_id = excluded.agent_id,
      updated_at = excluded.updated_at
  `).run(PRIMARY_ROW_KEY, OPENCLAW_AGENT_SCHEMA_VERSION, agentId, now, now);
  try {
    chmodSync(pathname, OPENCLAW_AGENT_DB_FILE_MODE);
  } catch {
    // Best-effort on Windows.
  }
  return db;
}

function readSqliteAuthStore(agentId: string): AuthProfilesStore | null {
  const pathname = getAgentAuthSqlitePath(agentId);
  if (!existsSync(pathname)) return null;

  const db = new DatabaseSync(pathname, { readOnly: true });
  try {
    const storeRow = db.prepare(
      'SELECT store_json FROM auth_profile_store WHERE store_key = ?',
    ).get(PRIMARY_ROW_KEY) as { store_json?: string } | undefined;
    const stateRow = db.prepare(
      'SELECT state_json FROM auth_profile_state WHERE state_key = ?',
    ).get(PRIMARY_ROW_KEY) as { state_json?: string } | undefined;

    const secrets = parseJsonCell(storeRow?.store_json);
    const state = parseJsonCell(stateRow?.state_json);
    if (!secrets?.profiles || typeof secrets.profiles !== 'object') {
      return null;
    }

    const version = Number(secrets.version ?? state?.version ?? AUTH_STORE_VERSION);
    return {
      version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
      profiles: secrets.profiles as AuthProfilesStore['profiles'],
      order: state?.order as AuthProfilesStore['order'],
      lastGood: state?.lastGood as AuthProfilesStore['lastGood'],
      usageStats: state?.usageStats as AuthProfilesStore['usageStats'],
    };
  } finally {
    db.close();
  }
}

async function readLegacyJsonAuthStore(agentId: string): Promise<AuthProfilesStore | null> {
  try {
    const profilesRaw = await readFile(getAuthProfilesJsonPath(agentId), 'utf-8');
    const parsed = JSON.parse(profilesRaw) as AuthProfilesStore;
    if (!parsed?.profiles || typeof parsed.profiles !== 'object') {
      return null;
    }

    let order = parsed.order;
    let lastGood = parsed.lastGood;
    let usageStats = parsed.usageStats;

    try {
      const stateRaw = await readFile(getAuthStateJsonPath(agentId), 'utf-8');
      const stateParsed = JSON.parse(stateRaw) as AuthProfilesStore;
      order = order ?? stateParsed.order;
      lastGood = lastGood ?? stateParsed.lastGood;
      usageStats = usageStats ?? stateParsed.usageStats;
    } catch {
      // auth-state.json is optional.
    }

    const version = Number(parsed.version ?? AUTH_STORE_VERSION);
    return {
      version: Number.isFinite(version) && version > 0 ? version : AUTH_STORE_VERSION,
      profiles: parsed.profiles,
      order,
      lastGood,
      usageStats,
    };
  } catch {
    return null;
  }
}

function buildPersistedStatePayload(store: AuthProfilesStore): Record<string, unknown> | null {
  const payload: Record<string, unknown> = { version: AUTH_STORE_VERSION };
  let hasState = false;
  if (store.order && Object.keys(store.order).length > 0) {
    payload.order = store.order;
    hasState = true;
  }
  if (store.lastGood && Object.keys(store.lastGood).length > 0) {
    payload.lastGood = store.lastGood;
    hasState = true;
  }
  if (store.usageStats && Object.keys(store.usageStats).length > 0) {
    payload.usageStats = store.usageStats;
    hasState = true;
  }
  return hasState ? payload : null;
}

function writeSqliteAuthStore(agentId: string, store: AuthProfilesStore): void {
  const db = ensureAgentDatabase(agentId);
  try {
    const now = Date.now();
    const secretsPayload = {
      version: store.version || AUTH_STORE_VERSION,
      profiles: store.profiles,
    };
    db.prepare(`
      INSERT INTO auth_profile_store (store_key, store_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(store_key) DO UPDATE SET
        store_json = excluded.store_json,
        updated_at = excluded.updated_at
    `).run(PRIMARY_ROW_KEY, JSON.stringify(secretsPayload), now);

    const statePayload = buildPersistedStatePayload(store);
    if (statePayload) {
      db.prepare(`
        INSERT INTO auth_profile_state (state_key, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(state_key) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(PRIMARY_ROW_KEY, JSON.stringify(statePayload), now);
    } else {
      db.prepare('DELETE FROM auth_profile_state WHERE state_key = ?').run(PRIMARY_ROW_KEY);
    }
  } finally {
    db.close();
  }
}

export async function loadAgentAuthProfileStore(agentId: string): Promise<AuthProfilesStore> {
  const fromSqlite = readSqliteAuthStore(agentId);
  if (fromSqlite && Object.keys(fromSqlite.profiles).length > 0) {
    return fromSqlite;
  }

  const fromJson = await readLegacyJsonAuthStore(agentId);
  if (fromJson) {
    return fromJson;
  }

  return { version: AUTH_STORE_VERSION, profiles: {} };
}

export async function saveAgentAuthProfileStore(
  agentId: string,
  store: AuthProfilesStore,
): Promise<void> {
  writeSqliteAuthStore(agentId, store);
}

/** Migrate legacy auth-profiles.json into SQLite when the runtime DB is empty. */
export async function migrateAgentAuthStoreToSqlite(agentId: string): Promise<boolean> {
  const sqliteStore = readSqliteAuthStore(agentId);
  if (sqliteStore && Object.keys(sqliteStore.profiles).length > 0) {
    return false;
  }

  const legacy = await readLegacyJsonAuthStore(agentId);
  if (!legacy || Object.keys(legacy.profiles).length === 0) {
    return false;
  }

  writeSqliteAuthStore(agentId, legacy);
  console.log(`[openclaw-auth-store] Migrated auth-profiles.json to SQLite for agent "${agentId}"`);
  return true;
}

export async function migrateAllAgentAuthStoresToSqlite(agentIds: string[]): Promise<void> {
  for (const agentId of agentIds) {
    try {
      await migrateAgentAuthStoreToSqlite(agentId);
    } catch (error) {
      console.warn(`[openclaw-auth-store] Failed to migrate auth store for agent "${agentId}":`, error);
    }
  }
}
