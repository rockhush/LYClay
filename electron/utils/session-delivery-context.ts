import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { extractSessionRecords } from './session-util';
import { getOpenClawConfigDir } from './paths';

type JsonRecord = Record<string, unknown>;

const CHANNEL_SESSION_SEGMENTS = new Set([
  'dingtalk',
  'wecom',
  'discord',
  'telegram',
  'slack',
  'feishu',
  'lark',
  'wechat',
]);

export type SessionDeliveryContext = {
  channel: string;
  to: string;
  accountId?: string;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseAgentIdFromSessionKey(sessionKey: string): string | null {
  if (!sessionKey.startsWith('agent:')) return null;
  return sessionKey.split(':')[1]?.trim() || null;
}

function deliveryContextFromSessionEntry(entry: JsonRecord): SessionDeliveryContext | null {
  const deliveryContext = entry.deliveryContext && typeof entry.deliveryContext === 'object'
    ? entry.deliveryContext as JsonRecord
    : undefined;
  const origin = entry.origin && typeof entry.origin === 'object'
    ? entry.origin as JsonRecord
    : undefined;

  const deliveryContextChannel = readNonEmptyString(deliveryContext?.channel);
  const deliveryContextTo = readNonEmptyString(deliveryContext?.to);
  const lastChannel = readNonEmptyString(entry.lastChannel);
  const lastTo = readNonEmptyString(entry.lastTo);

  // Gateway may stamp webchat on scheduled-task sessions while LYClaw stores the
  // real outbound target on lastChannel/lastTo after cron upsert.
  const useStoredOutboundTarget = deliveryContextChannel === 'webchat'
    && !deliveryContextTo
    && lastChannel
    && lastTo
    && CHANNEL_SESSION_SEGMENTS.has(lastChannel.toLowerCase());

  const channel = useStoredOutboundTarget
    ? lastChannel
    : deliveryContextChannel
      || lastChannel
      || readNonEmptyString(entry.channel)
      || readNonEmptyString(origin?.provider)
      || readNonEmptyString(origin?.surface);
  const to = useStoredOutboundTarget
    ? lastTo
    : deliveryContextTo
      || lastTo
      || readNonEmptyString(origin?.to);
  if (!channel || !to) return null;

  const accountId = readNonEmptyString(deliveryContext?.accountId)
    || readNonEmptyString(entry.lastAccountId)
    || readNonEmptyString(origin?.accountId);

  return { channel, to, accountId };
}

export function inferDeliveryContextFromSessionKey(sessionKey: string): SessionDeliveryContext | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 4) return null;

  const channel = parts[2]?.trim().toLowerCase();
  if (!channel || !CHANNEL_SESSION_SEGMENTS.has(channel)) return null;

  const to = parts.slice(3).join(':').trim();
  if (!to) return null;

  return { channel, to };
}

function findSessionEntry(
  store: JsonRecord,
  sessionKey: string,
): JsonRecord | null {
  const direct = store[sessionKey];
  if (direct && typeof direct === 'object') {
    return direct as JsonRecord;
  }

  for (const entry of extractSessionRecords(store)) {
    const key = readNonEmptyString(entry.key) || readNonEmptyString(entry.sessionKey);
    if (key === sessionKey) {
      return entry;
    }
  }

  return null;
}

export async function resolveSessionDeliveryContext(
  sessionKey: string,
): Promise<SessionDeliveryContext | null> {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey) return null;

  const agentId = parseAgentIdFromSessionKey(trimmedKey);
  if (agentId) {
    const sessionsPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
    try {
      const raw = await readFile(sessionsPath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw) as JsonRecord;
        const entry = findSessionEntry(parsed, trimmedKey);
        if (entry) {
          const fromEntry = deliveryContextFromSessionEntry(entry);
          if (fromEntry) return fromEntry;
        }
      }
    } catch {
      // Fall back to session-key inference below.
    }
  }

  return inferDeliveryContextFromSessionKey(trimmedKey);
}

export async function upsertSessionDeliveryContext(
  sessionKey: string,
  deliveryContext: SessionDeliveryContext,
): Promise<void> {
  const trimmedKey = sessionKey.trim();
  if (!trimmedKey) return;

  const agentId = parseAgentIdFromSessionKey(trimmedKey);
  if (!agentId) return;

  const sessionsPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  let store: JsonRecord = {};
  try {
    const raw = await readFile(sessionsPath, 'utf8');
    if (raw.trim()) {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        store = parsed as JsonRecord;
      }
    }
  } catch {
    store = {};
  }

  const existing = store[trimmedKey] && typeof store[trimmedKey] === 'object' && !Array.isArray(store[trimmedKey])
    ? store[trimmedKey] as JsonRecord
    : {};
  store[trimmedKey] = {
    ...existing,
    key: readNonEmptyString(existing.key) ?? trimmedKey,
    sessionKey: readNonEmptyString(existing.sessionKey) ?? trimmedKey,
    deliveryContext,
    lastChannel: deliveryContext.channel,
    lastTo: deliveryContext.to,
    ...(deliveryContext.accountId ? { lastAccountId: deliveryContext.accountId } : {}),
  };

  await mkdir(dirname(sessionsPath), { recursive: true });
  await writeFile(sessionsPath, JSON.stringify(store, null, 2), 'utf8');
}

export function buildChannelMessageTargetSystemPrompt(
  deliveryContext: SessionDeliveryContext,
): string {
  const accountLine = deliveryContext.accountId
    ? `- accountId="${deliveryContext.accountId}"`
    : '';
  return [
    '## Channel delivery context (message tool)',
    `This conversation is tied to channel "${deliveryContext.channel}".`,
    'When using the `message` tool to send files or text outbound:',
    `- channel="${deliveryContext.channel}"`,
    `- target="${deliveryContext.to}"`,
    accountLine,
    '- NEVER use target="self" (invalid for this channel).',
    '- Use the exact target value above, or rely on automatic delivery when deliver=true.',
  ].filter(Boolean).join('\n');
}

/** Stronger prompt for scheduled-task runs with a pre-configured external recipient. */
export function buildScheduledTaskDeliverySystemPrompt(
  deliveryContext: SessionDeliveryContext,
): string {
  const base = buildChannelMessageTargetSystemPrompt(deliveryContext);
  return [
    base,
    '',
    '## Scheduled task delivery (mandatory)',
    'This is an automated scheduled task. The outbound recipient is already configured above.',
    'Do NOT ask the user who to send to or request a recipient.',
    'Send the result using the `message` tool with the exact channel and target above.',
  ].join('\n');
}

export function mergeExtraSystemPrompt(
  existing: string | undefined,
  addition: string,
): string {
  const base = existing?.trim();
  const extra = addition.trim();
  if (!extra) return base ?? '';
  if (!base) return extra;
  if (base.includes(extra)) return base;
  return `${extra}\n\n${base}`;
}
