import type { RawMessage } from '@/stores/chat/types';

const DINGTALK_CARD_ENABLED_KEY = 'LYClaw:chat:dingtalk-card-enabled';
const DINGTALK_CARD_MESSAGE_IDS_KEY = 'LYClaw:chat:dingtalk-card-message-ids';
const DINGTALK_CARD_RUN_IDS_KEY = 'LYClaw:chat:dingtalk-card-run-ids';
const DINGTALK_CARD_FINGERPRINTS_KEY = 'LYClaw:chat:dingtalk-card-fingerprints';

export function loadDingtalkCardEnabled(): boolean {
  try {
    return window.localStorage.getItem(DINGTALK_CARD_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function persistDingtalkCardEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(DINGTALK_CARD_ENABLED_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage failures.
  }
}

function loadStringListMap(storageKey: string): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string[]> = {};
    for (const [sessionKey, ids] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof sessionKey !== 'string' || !sessionKey || !Array.isArray(ids)) continue;
      const normalizedIds = ids.filter((id): id is string => typeof id === 'string' && id.trim().length > 0);
      if (normalizedIds.length > 0) {
        out[sessionKey] = normalizedIds;
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveStringListMap(storageKey: string, map: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(map));
  } catch {
    // Ignore storage failures.
  }
}

function appendUniqueId(map: Record<string, string[]>, sessionKey: string, id: string): void {
  const trimmedId = id.trim();
  if (!sessionKey.trim() || !trimmedId) return;
  const existing = new Set(map[sessionKey] ?? []);
  if (existing.has(trimmedId)) return;
  existing.add(trimmedId);
  map[sessionKey] = [...existing];
}

export function getDingtalkCardMessageIdsForSession(sessionKey: string): Set<string> {
  const map = loadStringListMap(DINGTALK_CARD_MESSAGE_IDS_KEY);
  return new Set(map[sessionKey] ?? []);
}

export function getDingtalkCardRunIdsForSession(sessionKey: string): Set<string> {
  const map = loadStringListMap(DINGTALK_CARD_RUN_IDS_KEY);
  return new Set(map[sessionKey] ?? []);
}

export function getDingtalkCardFingerprintsForSession(sessionKey: string): Set<string> {
  const map = loadStringListMap(DINGTALK_CARD_FINGERPRINTS_KEY);
  return new Set(map[sessionKey] ?? []);
}

export function persistDingtalkCardMessageId(sessionKey: string, messageId: string): void {
  const map = loadStringListMap(DINGTALK_CARD_MESSAGE_IDS_KEY);
  appendUniqueId(map, sessionKey, messageId);
  saveStringListMap(DINGTALK_CARD_MESSAGE_IDS_KEY, map);
}

export function persistDingtalkCardRunId(sessionKey: string, runId: string): void {
  const map = loadStringListMap(DINGTALK_CARD_RUN_IDS_KEY);
  appendUniqueId(map, sessionKey, runId);
  saveStringListMap(DINGTALK_CARD_RUN_IDS_KEY, map);
}

export function persistDingtalkCardFingerprint(sessionKey: string, fingerprint: string): void {
  const map = loadStringListMap(DINGTALK_CARD_FINGERPRINTS_KEY);
  appendUniqueId(map, sessionKey, fingerprint);
  saveStringListMap(DINGTALK_CARD_FINGERPRINTS_KEY, map);
}

/** Stable hash for assistant reply text so card styling survives app restart. */
export function computeDingtalkCardFingerprint(text: string): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized) return '';
  let hash = 5381;
  for (let i = 0; i < normalized.length; i += 1) {
    hash = ((hash << 5) + hash) ^ normalized.charCodeAt(i);
  }
  return `fp-${(hash >>> 0).toString(36)}-${normalized.length}`;
}

function messageMatchesDingtalkCardRun(messageId: string, runId: string): boolean {
  if (!messageId || !runId) return false;
  return messageId === `run-${runId}` || messageId.startsWith(`run-${runId}-`);
}

function messageMatchesDingtalkCardFingerprint(
  message: RawMessage,
  fingerprints: Set<string>,
  getText: (content: unknown) => string,
): boolean {
  if (fingerprints.size === 0) return false;
  const fingerprint = computeDingtalkCardFingerprint(getText(message.content));
  return Boolean(fingerprint && fingerprints.has(fingerprint));
}

export function applyDingtalkCardDisplayFlags(
  messages: RawMessage[],
  cardMessageIds: Set<string>,
  cardRunIds: Set<string>,
  cardFingerprints: Set<string>,
  getText: (content: unknown) => string,
): RawMessage[] {
  if (cardMessageIds.size === 0 && cardRunIds.size === 0 && cardFingerprints.size === 0) {
    return messages;
  }
  return messages.map((message) => {
    if (message.role !== 'assistant' || message._dingtalkCard) return message;
    const messageId = typeof message.id === 'string' ? message.id.trim() : '';
    if (messageId && cardMessageIds.has(messageId)) {
      return { ...message, _dingtalkCard: true };
    }
    for (const runId of cardRunIds) {
      if (messageMatchesDingtalkCardRun(messageId, runId)) {
        return { ...message, _dingtalkCard: true };
      }
    }
    if (messageMatchesDingtalkCardFingerprint(message, cardFingerprints, getText)) {
      return { ...message, _dingtalkCard: true };
    }
    return message;
  });
}

export function propagateDingtalkCardFlagsFromLocal(
  messages: RawMessage[],
  localMessages: RawMessage[],
  getText: (content: unknown) => string,
): RawMessage[] {
  const flaggedById = new Set<string>();
  const flaggedByText = new Set<string>();
  for (const local of localMessages) {
    if (!local._dingtalkCard || local.role !== 'assistant') continue;
    if (typeof local.id === 'string' && local.id.trim()) {
      flaggedById.add(local.id.trim());
    }
    const text = getText(local.content).trim();
    if (text) flaggedByText.add(text);
  }
  if (flaggedById.size === 0 && flaggedByText.size === 0) return messages;

  return messages.map((message) => {
    if (message.role !== 'assistant' || message._dingtalkCard) return message;
    const messageId = typeof message.id === 'string' ? message.id.trim() : '';
    if (messageId && flaggedById.has(messageId)) {
      return { ...message, _dingtalkCard: true };
    }
    const text = getText(message.content).trim();
    if (text && flaggedByText.has(text)) {
      return { ...message, _dingtalkCard: true };
    }
    return message;
  });
}

/** After history reload, persist gateway ids/fingerprints for future cold starts. */
export function reconcileDingtalkCardPersistence(
  sessionKey: string,
  messages: RawMessage[],
  getText: (content: unknown) => string,
): void {
  for (const message of messages) {
    if (message.role !== 'assistant' || !message._dingtalkCard) continue;
    const messageId = typeof message.id === 'string' ? message.id.trim() : '';
    if (messageId) persistDingtalkCardMessageId(sessionKey, messageId);
    const fingerprint = computeDingtalkCardFingerprint(getText(message.content));
    if (fingerprint) persistDingtalkCardFingerprint(sessionKey, fingerprint);
  }
}

export function tagDingtalkCardMessageIfPending(
  message: RawMessage,
  sessionKey: string,
  runId: string,
  pendingRunIds: Record<string, string>,
  getText: (content: unknown) => string,
): RawMessage {
  if (message.role !== 'assistant') return message;
  const pendingRunId = pendingRunIds[sessionKey];
  if (!pendingRunId || pendingRunId !== runId) return message;
  const text = getText(message.content).trim();
  if (!text) return message;

  const messageId = typeof message.id === 'string' && message.id.trim()
    ? message.id.trim()
    : `run-${runId}`;
  persistDingtalkCardMessageId(sessionKey, messageId);
  persistDingtalkCardRunId(sessionKey, runId);
  const fingerprint = computeDingtalkCardFingerprint(text);
  if (fingerprint) persistDingtalkCardFingerprint(sessionKey, fingerprint);

  return { ...message, id: messageId, _dingtalkCard: true };
}

export function collectLocalMessagesForDingtalkMerge(
  messages: RawMessage[],
  snapshotMessages: RawMessage[],
): RawMessage[] {
  if (snapshotMessages.length === 0) return messages;
  if (messages.length === 0) return snapshotMessages;
  return propagateDingtalkCardFlagsFromLocal(messages, snapshotMessages, (content) => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .filter((block): block is { type?: string; text?: string } => (
          typeof block === 'object'
          && block != null
          && block.type === 'text'
          && typeof block.text === 'string'
        ))
        .map((block) => block.text!)
        .join('\n');
    }
    return '';
  });
}

export function clearDingtalkCardPendingRun(
  pendingRunIds: Record<string, string>,
  sessionKey: string,
): Record<string, string> {
  if (!pendingRunIds[sessionKey]) return pendingRunIds;
  const next = { ...pendingRunIds };
  delete next[sessionKey];
  return next;
}

export function shouldRenderAssistantAsDingtalkCard(
  message: RawMessage,
  forceDingtalkCard = false,
): boolean {
  return forceDingtalkCard || Boolean(message._dingtalkCard);
}
