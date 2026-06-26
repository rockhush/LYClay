import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

  const channel = readNonEmptyString(deliveryContext?.channel)
    || readNonEmptyString(entry.lastChannel)
    || readNonEmptyString(entry.channel)
    || readNonEmptyString(origin?.provider)
    || readNonEmptyString(origin?.surface);
  const to = readNonEmptyString(deliveryContext?.to)
    || readNonEmptyString(entry.lastTo)
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
