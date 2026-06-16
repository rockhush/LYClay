const STORAGE_KEY = 'LYClaw:chat:user-aborted-sessions';

export type UserAbortedSessionRecord = {
  abortedAt: number;
  runId?: string;
};

type UserAbortedSessionsMap = Record<string, UserAbortedSessionRecord>;

function readMap(): UserAbortedSessionsMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: UserAbortedSessionsMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key !== 'string' || !key.trim()) continue;
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const record = value as UserAbortedSessionRecord;
      if (typeof record.abortedAt !== 'number' || !Number.isFinite(record.abortedAt)) continue;
      out[key] = {
        abortedAt: record.abortedAt,
        ...(typeof record.runId === 'string' && record.runId.trim()
          ? { runId: record.runId.trim() }
          : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: UserAbortedSessionsMap): void {
  if (typeof window === 'undefined') return;
  try {
    if (Object.keys(map).length === 0) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // best-effort
  }
}

export function persistUserAbortedSession(sessionKey: string, runId?: string | null): void {
  const key = sessionKey.trim();
  if (!key) return;
  const map = readMap();
  map[key] = {
    abortedAt: Date.now(),
    ...(runId?.trim() ? { runId: runId.trim() } : {}),
  };
  writeMap(map);
}

export function clearUserAbortedSession(sessionKey: string): void {
  const key = sessionKey.trim();
  if (!key) return;
  const map = readMap();
  if (!(key in map)) return;
  delete map[key];
  writeMap(map);
}

export function isUserAbortedSession(sessionKey: string | null | undefined): boolean {
  const key = sessionKey?.trim();
  if (!key) return false;
  return Object.prototype.hasOwnProperty.call(readMap(), key);
}

export function listUserAbortedSessionKeys(): string[] {
  return Object.keys(readMap());
}

export async function reabortPersistedUserSessions(
  rpc: (method: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>,
): Promise<void> {
  const keys = listUserAbortedSessionKeys();
  if (keys.length === 0) return;

  await Promise.allSettled(
    keys.map(async (key) => {
      const record = readMap()[key];
      try {
        await rpc(
          'sessions.abort',
          {
            key,
            ...(record?.runId ? { runId: record.runId } : {}),
          },
          10_000,
        );
      } catch {
        // Gateway may already have stopped the run; keep the persisted flag.
      }
    }),
  );
}

/** Test helper */
export function _resetUserAbortedSessionsForTests(): void {
  writeMap({});
}
