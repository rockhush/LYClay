import i18n from '@/i18n';
import { invokeIpc } from '@/lib/api-client';
import {
  displayNameFromStagedDiskFileName,
  extractMediaAttachedRefs,
  isVirtualMediaUri,
  preferAuthoritativeMediaRefs,
} from '../../../shared/media-staging';
import type { AttachedFileMeta, ChatSession, ContentBlock, RawMessage, ToolStatus } from './types';

const COMPLEX_TASK_PLAN_MARKER = '[LYClaw complex task planning phase]';
const COMPLEX_TASK_EXECUTION_MARKER = '[LYClaw staged execution phase]';

// Module-level timestamp tracking the last chat event received.
// Used by the safety timeout to avoid false-positive "no response" errors
// during tool-use conversations where streamingMessage is temporarily cleared
// between tool-result finals and the next delta.
let _lastChatEventAt = 0;

/** Normalize a timestamp to milliseconds. Handles both seconds and ms. */
function toMs(ts: number): number {
  // Timestamps < 1e12 are in seconds (before ~2033); >= 1e12 are milliseconds
  return ts < 1e12 ? ts * 1000 : ts;
}

// Timer for fallback history polling during active sends.
// If no streaming events arrive within a few seconds, we periodically
// poll chat.history to surface intermediate tool-call turns.
let _historyPollTimer: ReturnType<typeof setTimeout> | null = null;

const _abortedChatRunIds = new Set<string>();

export function markAbortedChatRun(runId: string): void {
  const id = runId.trim();
  if (id) _abortedChatRunIds.add(id);
}

export function isAbortedChatRun(runId: string): boolean {
  return _abortedChatRunIds.has(runId.trim());
}

export function forgetAbortedChatRun(runId: string): void {
  _abortedChatRunIds.delete(runId.trim());
}

export function clearAbortedChatRuns(): void {
  _abortedChatRunIds.clear();
}

// Late abort-type error events may arrive after the run id was forgotten.
let _lastUserAbortAt = 0;
const USER_ABORT_ERROR_SUPPRESS_WINDOW_MS = 15_000;

export function markUserAbort(): void {
  _lastUserAbortAt = Date.now();
}

export function isWithinUserAbortWindow(): boolean {
  return _lastUserAbortAt > 0 && Date.now() - _lastUserAbortAt < USER_ABORT_ERROR_SUPPRESS_WINDOW_MS;
}

/** Generic runtime abort strings (user stop and system-side abort both use these). */
export function isAbortErrorMessage(error: string | null | undefined): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  if (normalized.includes('operation was aborted')) return true;
  if (normalized.includes('request was aborted')) return true;
  return false;
}

/** Broader abort detection for live event routing (includes partial "abort" tokens). */
export function isAbortRelatedErrorMessage(error: string | null | undefined): boolean {
  if (!error) return false;
  if (isAbortErrorMessage(error)) return true;
  return error.toLowerCase().includes('abort');
}

export function shouldTreatAbortAsUserStop(
  error: string | null | undefined,
  options: {
    runId?: string | null;
    runAborted?: boolean;
  } = {},
): boolean {
  if (!isAbortRelatedErrorMessage(error)) return false;
  if (options.runId && isAbortedChatRun(options.runId)) return true;
  if (options.runAborted) return true;
  return isWithinUserAbortWindow();
}

// Timer for delayed error finalization. When the Gateway reports a mid-stream
// error (e.g. "terminated"), it may retry internally and recover. We wait
// before committing the error to give the recovery path a chance.
let _errorRecoveryTimer: ReturnType<typeof setTimeout> | null = null;

const USER_SECURITY_DENIAL_PATTERNS = [
  /NETWORK_ACCESS_DENIED_BY_USER/i,
  /COMMAND_EXECUTION_DENIED_BY_USER/i,
  /FILE_PATH_ACCESS_DENIED_BY_USER/i,
  /OPEN_TARGET_DENIED_BY_USER/i,
  /MCP_SERVER_ENABLE_DENIED_BY_USER/i,
  /MODEL_SECRET_DENIED_BY_USER/i,
  /Network access denied:/i,
  /Command execution denied:/i,
  /Local file path access denied by user:/i,
  /Open target denied:/i,
  /MCP server enable denied:/i,
  /Model send denied because message contains secret-like values/i,
];

export function isUserSecurityDenialMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  return USER_SECURITY_DENIAL_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * True when the error bar already shows the dedicated backend-unresponsive copy.
 * Abort strings are handled separately and must not map here.
 */
export function isBackendRunFailureError(error: string | null | undefined): boolean {
  if (!error) return false;
  return error === i18n.t('chat:errors.backendRunStopped');
}

/**
 * Runtime errors that carry no actionable information for the user and should
 * not surface in the chat error bar or run termination notice.
 */
export function isSuppressedRunError(error: string | null | undefined): boolean {
  if (!error) return false;
  const normalized = error.toLowerCase();
  if (normalized.includes('session file changed while embedded prompt lock was released')) return true;
  if (isAbortErrorMessage(error) && isWithinUserAbortWindow()) return true;
  return false;
}

export function resolveRunFailureErrorMessage(error: string): string {
  if (isAbortErrorMessage(error)) {
    return i18n.t('chat:errors.runAbortedBySystem');
  }
  return truncateRunErrorMessage(error);
}

const RUN_ERROR_MESSAGE_MAX_CHARS = 480;

/** Keep runtime error banners readable and prevent huge payloads from freezing the UI. */
export function truncateRunErrorMessage(message: string, maxChars = RUN_ERROR_MESSAGE_MAX_CHARS): string {
  const normalized = message.replace(/\s+/g, ' ').trim();
  if (!normalized) return 'An error occurred';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

const RECOVERABLE_RUNTIME_ERROR_PATTERN = /terminated|temporarily unavailable|rate limit|overloaded|429|502|503|504|timeout/i;

/** Gateway may retry these errors internally; others should end the run immediately. */
export function isRecoverableRuntimeError(message: string): boolean {
  return RECOVERABLE_RUNTIME_ERROR_PATTERN.test(message);
}

/**
 * 把一条「用户拒绝安全确认」的错误消息转成会话内的温和取消提示。
 * 能从文件路径拒绝里提取具体路径，其余拒绝类型回退到通用文案。
 */
export function buildSecurityCancelNotice(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  const fileMatch = text.match(/Local file path access denied by user:\s*(.+?)\s*$/i);
  if (fileMatch?.[1]) {
    return i18n.t('chat:notices.fileAccessCancelled', { path: fileMatch[1].trim() });
  }
  return i18n.t('chat:notices.securityCancelled');
}

function clearErrorRecoveryTimer(): void {
  if (_errorRecoveryTimer) {
    clearTimeout(_errorRecoveryTimer);
    _errorRecoveryTimer = null;
  }
}

function clearHistoryPoll(): void {
  if (_historyPollTimer) {
    clearTimeout(_historyPollTimer);
    _historyPollTimer = null;
  }
}

const ABORT_HISTORY_QUIET_MS = 2_000;
let _abortHistoryQuietUntil = 0;

function markAbortHistoryQuietPeriod(ms = ABORT_HISTORY_QUIET_MS): void {
  _abortHistoryQuietUntil = Date.now() + ms;
}

function isAbortHistoryQuietPeriod(): boolean {
  return Date.now() < _abortHistoryQuietUntil;
}

// ── Local image cache ─────────────────────────────────────────
// The Gateway doesn't store image attachments in session content blocks,
// so we cache them locally keyed by staged file path (which appears in the
// [media attached: <path> ...] reference in the Gateway's user message text).
// Keying by path avoids the race condition of keying by runId (which is only
// available after the RPC returns, but history may load before that).
const IMAGE_CACHE_KEY = 'LYClaw:image-cache';
const IMAGE_CACHE_MAX = 100; // max entries to prevent unbounded growth

function loadImageCache(): Map<string, AttachedFileMeta> {
  try {
    const raw = localStorage.getItem(IMAGE_CACHE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as Array<[string, AttachedFileMeta]>;
      return new Map(entries);
    }
  } catch { /* ignore parse errors */ }
  return new Map();
}

function saveImageCache(cache: Map<string, AttachedFileMeta>): void {
  try {
    // Evict oldest entries if over limit
    const entries = Array.from(cache.entries());
    const trimmed = entries.length > IMAGE_CACHE_MAX
      ? entries.slice(entries.length - IMAGE_CACHE_MAX)
      : entries;
    localStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(trimmed));
  } catch { /* ignore quota errors */ }
}

const _imageCache = loadImageCache();

function normalizeBlockText(text: string | undefined): string {
  return typeof text === 'string' ? text.replace(/\r\n/g, '\n').trim() : '';
}

function compactProgressiveTextParts(parts: string[]): string[] {
  const compacted: string[] = [];

  for (const part of parts) {
    const current = normalizeBlockText(part);
    if (!current) continue;

    const previous = compacted.at(-1);
    if (!previous) {
      compacted.push(part);
      continue;
    }

    const normalizedPrevious = normalizeBlockText(previous);
    if (!normalizedPrevious) {
      compacted[compacted.length - 1] = part;
      continue;
    }

    if (current === normalizedPrevious || normalizedPrevious.startsWith(current)) {
      continue;
    }

    if (current.startsWith(normalizedPrevious)) {
      compacted[compacted.length - 1] = part;
      continue;
    }

    compacted.push(part);
  }

  return compacted;
}

const REASONING_FIELD_NAMES = [
  'reasoning_content',
  'reasoningContent',
  'reasoning',
  'reasoningText',
  'thinking',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function collectReasoningFields(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const parts: string[] = [];
  for (const field of REASONING_FIELD_NAMES) {
    const value = record[field];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    }
  }
  return parts;
}

function normalizeReasoningContentBlock(block: ContentBlock): ContentBlock {
  const record = block as unknown as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  if (type === 'thinking') {
    return { ...block };
  }

  const reasoningParts = collectReasoningFields(record);
  if (reasoningParts.length === 0 && (type === 'reasoning' || type === 'reasoning_content')) {
    const text = typeof record.text === 'string' ? record.text.trim() : '';
    if (text) reasoningParts.push(text);
  }

  if (reasoningParts.length === 0) {
    return { ...block };
  }

  return {
    ...block,
    type: 'thinking',
    thinking: reasoningParts.join('\n'),
  };
}

function normalizeLiveContentBlocks(content: ContentBlock[]): ContentBlock[] {
  return content.map(normalizeReasoningContentBlock);
}

function contentToBlocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return normalizeLiveContentBlocks(content as ContentBlock[]);
  if (typeof content === 'string' && content.trim()) {
    return [{ type: 'text', text: content }];
  }
  return [];
}

function collectReasoningFromMessage(record: Record<string, unknown>): string[] {
  const parts = collectReasoningFields(record);
  for (const nestedKey of ['delta', 'message']) {
    parts.push(...collectReasoningFields(asRecord(record[nestedKey])));
  }
  const choices = record.choices;
  if (Array.isArray(choices)) {
    for (const choice of choices) {
      const choiceRecord = asRecord(choice);
      parts.push(...collectReasoningFields(choiceRecord));
      parts.push(...collectReasoningFields(asRecord(choiceRecord?.delta)));
      parts.push(...collectReasoningFields(asRecord(choiceRecord?.message)));
    }
  }
  return compactProgressiveTextParts(parts).filter(Boolean);
}

function stripTopLevelReasoningFields(record: Record<string, unknown>): Record<string, unknown> {
  const next = { ...record };
  for (const field of REASONING_FIELD_NAMES) {
    delete next[field];
  }
  return next;
}

function normalizeStreamingMessage(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;

  const msgRecord = message as Record<string, unknown>;
  const reasoningParts = collectReasoningFromMessage(msgRecord);
  const rawContent = msgRecord.content;
  const contentBlocks = contentToBlocks(rawContent);
  const existingThinking = new Set(
    contentBlocks
      .filter((block) => block.type === 'thinking' && typeof block.thinking === 'string')
      .map((block) => normalizeBlockText(block.thinking)),
  );
  const reasoningBlocks = reasoningParts
    .filter((part) => !existingThinking.has(normalizeBlockText(part)))
    .map((thinking): ContentBlock => ({ type: 'thinking', thinking }));

  const normalizedContent = [...reasoningBlocks, ...contentBlocks];
  const didChange = reasoningBlocks.length > 0
    || !Array.isArray(rawContent)
    || normalizedContent.some((block, index) => block !== (rawContent as ContentBlock[])[index])
    || normalizedContent.length !== (Array.isArray(rawContent) ? rawContent.length : 0);

  if (reasoningBlocks.length > 0) {
    console.debug('[chat] normalized reasoning content', {
      fields: Object.keys(msgRecord).filter((key) => key.toLowerCase().includes('reason') || key.toLowerCase().includes('thinking')),
      chars: reasoningBlocks.reduce((sum, block) => sum + (block.thinking?.length ?? 0), 0),
    });
  }

  return didChange
    ? { ...stripTopLevelReasoningFields(msgRecord), content: normalizedContent }
    : message;
}

/**
 * Strip Gateway-injected metadata that does NOT exist on the renderer's
 * optimistic user message but is echoed back when the Gateway persists it:
 *   - leading timestamp `[Wed 2026-04-22 10:30 GMT+8] `
 *   - `[message_id: uuid]` tags sprinkled throughout the text
 *   - `[media attached: path (mime) | path]` references appended when the
 *     renderer sends attachments via `chat:sendWithMedia`
 *   - Gateway-injected "Conversation info (untrusted metadata): ..." blocks
 *
 * Keeping this aligned with `cleanUserText` in `pages/Chat/message-utils.ts`
 * is important: the user bubble renders the cleaned text, so the comparison
 * used to dedupe optimistic vs server echoes must operate on the same
 * cleaned form — otherwise the same visible message renders twice.
 */
function stripGatewayUserMetadata(text: string): string {
  return text
    .replace(/\s*\[media attached:[^\]]*\]/g, '')
    .replace(/\s*\[message_id:\s*[^\]]+\]/g, '')
    .replace(/\s*\[Working Directory:[^\]]*\]/g, '')
    .replace(/Sender\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/gi, '')
    .replace(/Sender\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/Conversation info\s*\([^)]*\):\s*```[a-z]*\n[\s\S]*?```\s*/gi, '')
    .replace(/Conversation info\s*\([^)]*\):\s*\{[\s\S]*?\}\s*/gi, '')
    .replace(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/gi, '')
    .trim();
}

function maybeStripMimoDirective(text: string): string {
  const directiveMarker = '[系统指令]';
  const directiveStart = text.lastIndexOf(directiveMarker);
  if (directiveStart < 0) return text;

  const endMarkers = ['必须使用中文输出内容。', '必须全程使用中文。'];
  if (endMarkers.some((marker) => text.indexOf(marker, directiveStart) >= 0)) {
    return text.slice(0, directiveStart).trimEnd();
  }

  return text;
}

export function normalizeComparableUserText(content: unknown): string {
  let text = stripGatewayUserMetadata(getMessageText(content));
  text = maybeStripMimoDirective(text);
  text = stripAttachmentPlaceholderPrefix(text);
  return text.replace(/\s+/g, ' ').trim();
}

const ATTACHMENT_ONLY_UI_TEXT = '(file attached)';
const ATTACHMENT_ONLY_RUNTIME_TEXT = 'Process the attached file(s).';

function stripAttachmentPlaceholderPrefix(text: string): string {
  return text.replace(/\/think\s+(?:off|medium|high)\s+/i, '').trim();
}

export function isAttachmentOnlyPlaceholderText(text: string): boolean {
  const normalized = stripAttachmentPlaceholderPrefix(text.replace(/\s+/g, ' ').trim());
  return normalized === ATTACHMENT_ONLY_UI_TEXT || normalized === ATTACHMENT_ONLY_RUNTIME_TEXT;
}

export function areEquivalentAttachmentOnlyUserTexts(a: string, b: string): boolean {
  const normalizedA = stripAttachmentPlaceholderPrefix(a.replace(/\s+/g, ' ').trim());
  const normalizedB = stripAttachmentPlaceholderPrefix(b.replace(/\s+/g, ' ').trim());
  if (!normalizedA || !normalizedB) return false;
  if (normalizedA === normalizedB) return isAttachmentOnlyPlaceholderText(normalizedA);
  return (
    (normalizedA === ATTACHMENT_ONLY_UI_TEXT && normalizedB === ATTACHMENT_ONLY_RUNTIME_TEXT)
    || (normalizedA === ATTACHMENT_ONLY_RUNTIME_TEXT && normalizedB === ATTACHMENT_ONLY_UI_TEXT)
  );
}

function extractOriginalMessageFromComplexTaskPrompt(text: string): string {
  const markers = ['用户原始需求：', '用户原始需求:'];
  for (const marker of markers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) {
      const original = text.slice(index + marker.length).trim();
      if (original) return original;
    }
  }
  return text;
}

function normalizeComplexTaskControlUserMessages(messages: RawMessage[]): RawMessage[] {
  const visibleMessages: RawMessage[] = [];
  const seenUserTexts = new Set<string>();

  for (const message of messages) {
    if (message.role !== 'user') {
      visibleMessages.push(message);
      continue;
    }

    const text = getMessageText(message.content);
    const isPlanningControl = text.includes(COMPLEX_TASK_PLAN_MARKER);
    const isExecutionControl = text.includes(COMPLEX_TASK_EXECUTION_MARKER);
    if (!isPlanningControl && !isExecutionControl) {
      const comparable = normalizeComparableUserText(message.content);
      if (comparable) seenUserTexts.add(comparable);
      visibleMessages.push(message);
      continue;
    }

    const original = extractOriginalMessageFromComplexTaskPrompt(text);
    const comparable = normalizeComparableUserText(original);
    if (isExecutionControl && comparable && seenUserTexts.has(comparable)) {
      continue;
    }
    if (comparable) seenUserTexts.add(comparable);
    visibleMessages.push({
      ...message,
      content: original,
    });
  }

  return visibleMessages;
}

function getComparableAttachmentSignature(message: Pick<RawMessage, '_attachedFiles'>): string {
  const files = (message._attachedFiles || [])
    .map((file) => file.filePath || `${file.fileName}|${file.mimeType}|${file.fileSize}`)
    .filter(Boolean)
    .sort();
  return files.join('::');
}

function matchesOptimisticUserMessage(
  candidate: RawMessage,
  optimistic: RawMessage,
  optimisticTimestampMs: number,
): boolean {
  if (candidate.role !== 'user') return false;

  const optimisticText = normalizeComparableUserText(optimistic.content);
  const candidateText = normalizeComparableUserText(candidate.content);
  const sameText = optimisticText.length > 0 && optimisticText === candidateText;
  const equivalentAttachmentOnlyTexts = areEquivalentAttachmentOnlyUserTexts(optimisticText, candidateText);

  const optimisticAttachments = getComparableAttachmentSignature(optimistic);
  const candidateAttachments = getComparableAttachmentSignature(candidate);
  const sameAttachments = optimisticAttachments.length > 0 && optimisticAttachments === candidateAttachments;

  const hasOptimisticTimestamp = Number.isFinite(optimisticTimestampMs) && optimisticTimestampMs > 0;
  const hasCandidateTimestamp = candidate.timestamp != null;
  const timestampMatches = hasOptimisticTimestamp && hasCandidateTimestamp
    ? Math.abs(toMs(candidate.timestamp as number) - optimisticTimestampMs) < 5000
    : false;
  const timestampCompatible = timestampMatches || !hasCandidateTimestamp || !hasOptimisticTimestamp;

  if (sameText && sameAttachments) return true;
  if (sameText && (!optimisticAttachments || !candidateAttachments) && timestampCompatible) return true;
  if (sameAttachments && (!optimisticText || !candidateText) && timestampCompatible) return true;
  if (equivalentAttachmentOnlyTexts) return true;
  return false;
}

export function areEquivalentUserMessageTexts(a: RawMessage, b: RawMessage): boolean {
  if (a.role !== 'user' || b.role !== 'user') return false;

  const textA = normalizeComparableUserText(a.content);
  const textB = normalizeComparableUserText(b.content);
  if (textA && textB && textA === textB) return true;
  if (areEquivalentAttachmentOnlyUserTexts(textA, textB)) return true;

  if (!textA && !textB) {
    const signatureA = getComparableAttachmentSignature(a);
    const signatureB = getComparableAttachmentSignature(b);
    return signatureA.length > 0 && signatureA === signatureB;
  }

  return false;
}

export function dedupeConsecutiveEquivalentUserMessages(messages: RawMessage[]): RawMessage[] {
  if (messages.length < 2) return messages;

  const result: RawMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user') {
      result.push(message);
      continue;
    }

    const previous = result.length > 0 ? result[result.length - 1] : null;
    if (previous?.role === 'user' && areEquivalentUserMessageTexts(previous, message)) {
      result[result.length - 1] = mergeAttachmentOnlyUserMessage(previous, message);
      continue;
    }

    result.push(message);
  }

  return result.length === messages.length ? messages : result;
}

function dedupeEchoedUserMessages(messages: RawMessage[]): RawMessage[] {
  if (messages.length < 2) return messages;

  const result: RawMessage[] = [];
  for (const message of messages) {
    if (message.role !== 'user') {
      result.push(message);
      continue;
    }

    const existingTimestampMs = (existing: RawMessage) => (
      existing.timestamp != null ? toMs(existing.timestamp as number) : Date.now()
    );
    const duplicateIndex = result.findIndex((existing) => (
      existing.role === 'user'
      && matchesOptimisticUserMessage(message, existing, existingTimestampMs(existing))
    ));

    if (duplicateIndex < 0) {
      result.push(message);
      continue;
    }

    result[duplicateIndex] = mergeAttachmentOnlyUserMessage(result[duplicateIndex]!, message);
  }

  return result.length === messages.length ? messages : result;
}

export function dedupeEquivalentAttachmentUserMessages(messages: RawMessage[]): RawMessage[] {
  if (messages.length < 2) return messages;
  const echoed = dedupeEchoedUserMessages(messages);
  return dedupeConsecutiveEquivalentUserMessages(echoed);
}

function mergeAttachmentOnlyUserMessage(existing: RawMessage, incoming: RawMessage): RawMessage {
  const existingFiles = existing._attachedFiles ?? [];
  const incomingFiles = incoming._attachedFiles ?? [];
  const mergedFiles = existingFiles.length > 0 ? existingFiles : incomingFiles;
  const existingText = normalizeComparableUserText(existing.content);
  const incomingText = normalizeComparableUserText(incoming.content);
  const base = incomingFiles.length > 0 ? incoming : existingFiles.length > 0 ? existing : incoming;
  const other = base === incoming ? existing : incoming;

  let content = base.content;
  const baseText = base === incoming ? incomingText : existingText;
  const otherText = base === incoming ? existingText : incomingText;
  if (isAttachmentOnlyPlaceholderText(String(baseText)) && otherText && !isAttachmentOnlyPlaceholderText(otherText)) {
    content = other.content;
  } else if (!baseText && otherText) {
    content = other.content;
  } else if (isAttachmentOnlyPlaceholderText(String(baseText)) && isAttachmentOnlyPlaceholderText(otherText)) {
    content = other.content ?? base.content;
  }

  return {
    ...other,
    ...base,
    id: base.id ?? other.id,
    timestamp: base.timestamp ?? other.timestamp,
    content,
    _attachedFiles: mergedFiles.length > 0 ? mergedFiles : undefined,
  };
}

function snapshotStreamingAssistantMessage(
  currentStream: RawMessage | null,
  existingMessages: RawMessage[],
  runId: string,
): RawMessage[] {
  if (!currentStream) return [];

  const normalizedStream = normalizeStreamingMessage(currentStream) as RawMessage;
  const streamRole = normalizedStream.role;
  if (streamRole !== 'assistant' && streamRole !== undefined) return [];

  const snapId = normalizedStream.id || `${runId || 'run'}-turn-${existingMessages.length}`;
  if (existingMessages.some((message) => message.id === snapId)) return [];

  return [{
    ...normalizedStream,
    role: 'assistant',
    id: snapId,
  }];
}

function getLatestOptimisticUserMessage(messages: RawMessage[], userTimestampMs: number): RawMessage | undefined {
  return [...messages].reverse().find(
    (message) => message.role === 'user' && (!message.timestamp || Math.abs(toMs(message.timestamp) - userTimestampMs) < 5000),
  );
}

function upsertImageCacheEntry(filePath: string, file: Omit<AttachedFileMeta, 'filePath'>): void {
  _imageCache.set(filePath, { ...file, filePath });
  saveImageCache(_imageCache);
}

function withAttachedFileSource(
  file: AttachedFileMeta,
  source: AttachedFileMeta['source'],
): AttachedFileMeta {
  return file.source ? file : { ...file, source };
}

/** Extract plain text from message content (string or content blocks) */
function getMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === 'text' && b.text)
      .map(b => b.text!);
    return compactProgressiveTextParts(parts).join('\n');
  }
  return '';
}

/** Extract media file refs from [media attached: <path> (<mime>) | ...] patterns */
function extractMediaRefs(text: string): Array<{ filePath: string; mimeType: string }> {
  return preferAuthoritativeMediaRefs(extractMediaAttachedRefs(text));
}

/** Map common file extensions to MIME types */
function mimeFromExtension(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'bmp': 'image/bmp',
    'avif': 'image/avif',
    'svg': 'image/svg+xml',
    // Documents
    'pdf': 'application/pdf',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'txt': 'text/plain',
    'csv': 'text/csv',
    'md': 'text/markdown',
    'rtf': 'application/rtf',
    'epub': 'application/epub+zip',
    // Archives
    'zip': 'application/zip',
    'tar': 'application/x-tar',
    'gz': 'application/gzip',
    'rar': 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    // Audio
    'mp3': 'audio/mpeg',
    'wav': 'audio/wav',
    'ogg': 'audio/ogg',
    'aac': 'audio/aac',
    'flac': 'audio/flac',
    'm4a': 'audio/mp4',
    // Video
    'mp4': 'video/mp4',
    'mov': 'video/quicktime',
    'avi': 'video/x-msvideo',
    'mkv': 'video/x-matroska',
    'webm': 'video/webm',
    'm4v': 'video/mp4',
  };
  return map[ext] || 'application/octet-stream';
}

function isWindowsRuntime(): boolean {
  return typeof navigator !== 'undefined' && /win/i.test(navigator.platform);
}

function isPreviewableRawFilePath(filePath: string): boolean {
  if (!filePath || /[*?]/.test(filePath)) return false;
  if (isWindowsRuntime() && filePath.startsWith('/') && !filePath.startsWith('~/')) return false;
  return true;
}

/**
 * Extract raw file paths from message text.
 * Detects absolute paths (Unix: / or ~/, Windows: C:\ etc.) ending with common file extensions.
 * Handles both image and non-image files, consistent with channel push message behavior.
 */
function extractRawFilePaths(text: string): Array<{ filePath: string; mimeType: string }> {
  const refs: Array<{ filePath: string; mimeType: string }> = [];
  const seen = new Set<string>();
  const exts = 'png|jpe?g|gif|webp|bmp|avif|svg|pdf|docx?|xlsx?|pptx?|txt|csv|md|rtf|epub|zip|tar|gz|rar|7z|mp3|wav|ogg|aac|flac|m4a|mp4|mov|avi|mkv|webm|m4v';
  // Unix absolute paths (/... or ~/...) — lookbehind rejects mid-token slashes
  // (e.g. "path/to/file.mp4", "https://example.com/file.mp4")
  const unixRegex = new RegExp(`(?<![\\w./:])((?:\\/|~\\/)[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  // Windows absolute paths (C:\... D:\...) — lookbehind rejects drive letter glued to a word
  const winRegex = new RegExp(`(?<![\\w])([A-Za-z]:\\\\[^\\s\\n"'()\\[\\],<>]*?\\.(?:${exts}))`, 'gi');
  for (const regex of [unixRegex, winRegex]) {
    let match;
    while ((match = regex.exec(text)) !== null) {
      const p = match[1];
      if (p && isPreviewableRawFilePath(p) && !seen.has(p)) {
        seen.add(p);
        refs.push({ filePath: p, mimeType: mimeFromExtension(p) });
      }
    }
  }
  return refs;
}

/**
 * Extract images from a content array (including nested tool_result content).
 * Converts them to AttachedFileMeta entries with preview set to data URL or remote URL.
 */
function extractImagesAsAttachedFiles(content: unknown): AttachedFileMeta[] {
  if (!Array.isArray(content)) return [];
  const files: AttachedFileMeta[] = [];

  for (const block of content as ContentBlock[]) {
    if (block.type === 'image') {
      // Path 1: Anthropic source-wrapped format {source: {type, media_type, data}}
      if (block.source) {
        const src = block.source;
        const mimeType = src.media_type || 'image/jpeg';

        if (src.type === 'base64' && src.data) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: `data:${mimeType};base64,${src.data}`,
          });
        } else if (src.type === 'url' && src.url) {
          files.push({
            fileName: 'image',
            mimeType,
            fileSize: 0,
            preview: src.url,
          });
        }
      }
      // Path 2: Flat format from Gateway tool results {data, mimeType}
      else if (block.data) {
        const mimeType = block.mimeType || 'image/jpeg';
        files.push({
          fileName: 'image',
          mimeType,
          fileSize: 0,
          preview: `data:${mimeType};base64,${block.data}`,
        });
      }
    }
    // Recurse into tool_result content blocks
    if ((block.type === 'tool_result' || block.type === 'toolResult') && block.content) {
      files.push(...extractImagesAsAttachedFiles(block.content));
    }
  }
  return files;
}

function isReasonableAttachmentBaseName(s: string): boolean {
  if (!s || s.length > 255) return false;
  if (/[\x00-\x1f<>:"|?*]/.test(s)) return false;
  if (s.includes('\uFFFD')) return false;
  return true;
}

/**
 * When UTF-8 filename bytes were mis-decoded as Latin-1 / ANSI (each byte → one BMP char),
 * re-pack code units 0–255 as bytes and strict-decode as UTF-8. Fixes common Chinese/European
 * mojibake in tool paths before they reach the UI.
 */
function tryRecoverUtf8FromByteWiseLatin1(fileName: string): string | null {
  if (!fileName || fileName.includes('\uFFFD')) return null;
  const bytes: number[] = [];
  for (let i = 0; i < fileName.length; i++) {
    const c = fileName.charCodeAt(i);
    if (c > 255) return null;
    bytes.push(c);
  }
  if (!bytes.some((b) => b >= 0x80)) return null;
  try {
    const recovered = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
    if (recovered === fileName || !isReasonableAttachmentBaseName(recovered)) return null;
    return recovered;
  } catch {
    return null;
  }
}

/**
 * Normalize a path basename for display on attachment cards (URL parts, UTF-8/Latin1 mixups, GBK).
 */
export function normalizeAttachmentBaseName(fileName: string): string {
  let s = fileName;
  try {
    s = decodeURIComponent(fileName);
  } catch {
    s = fileName;
  }

  const utf8Recovered = tryRecoverUtf8FromByteWiseLatin1(s);
  if (utf8Recovered) s = utf8Recovered;

  // GBK bytes shown in a Latin/UTF-8 context (heuristic; optional iconv-lite)
  const hasGarbledChars = /\uFFFD|[\u0080-\u00ff]/.test(s);
  if (hasGarbledChars) {
    try {
      const iconv = require('iconv-lite') as { decode: (buf: Buffer, enc: string) => string };
      const buffer = Buffer.from(s, 'binary');
      const converted = iconv.decode(buffer, 'GBK');
      if (/[\u4e00-\u9fff]/.test(converted) && isReasonableAttachmentBaseName(converted)) {
        return converted;
      }
    } catch {
      /* iconv-lite unavailable or decode failed */
    }
  }

  return s;
}

/** Last segment of `filePath`, normalized for display (encoding fixes). */
export function attachmentFileNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() || 'file';
  const display = displayNameFromStagedDiskFileName(base);
  return normalizeAttachmentBaseName(display);
}

/**
 * Build an AttachedFileMeta entry for a file ref, using cache if available.
 */
function makeAttachedFile(
  ref: { filePath: string; mimeType: string },
  source: AttachedFileMeta['source'] = 'message-ref',
): AttachedFileMeta {
  const cached = _imageCache.get(ref.filePath);
  if (cached) return { ...cached, filePath: ref.filePath, source };
  const fileName = attachmentFileNameFromPath(ref.filePath);
  return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath, source };
}

/**
 * Extract file path from a tool call's arguments by toolCallId.
 * Searches common argument names: file_path, filePath, path, file.
 */
function getToolCallFilePath(msg: RawMessage, toolCallId: string): string | undefined {
  if (!toolCallId) return undefined;

  // Anthropic/normalized format — toolCall blocks in content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id === toolCallId) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
          if (typeof fp === 'string') return fp;
        }
      }
    }
  }

  // OpenAI format — tool_calls array on the message itself
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      if (tc.id !== toolCallId) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
        if (typeof fp === 'string') return fp;
      }
    }
  }

  return undefined;
}

/**
 * Collect all tool call file paths from a message into a Map<toolCallId, filePath>.
 */
function collectToolCallPaths(msg: RawMessage, paths: Map<string, string>): void {
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type === 'tool_use' || block.type === 'toolCall') && block.id) {
        const args = (block.input ?? block.arguments) as Record<string, unknown> | undefined;
        if (args) {
          const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
          if (typeof fp === 'string') paths.set(block.id, fp);
        }
      }
    }
  }
  const msgAny = msg as unknown as Record<string, unknown>;
  const toolCalls = msgAny.tool_calls ?? msgAny.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls as Array<Record<string, unknown>>) {
      const id = typeof tc.id === 'string' ? tc.id : '';
      if (!id) continue;
      const fn = (tc.function ?? tc) as Record<string, unknown>;
      let args: Record<string, unknown> | undefined;
      try {
        args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : (fn.arguments ?? fn.input) as Record<string, unknown>;
      } catch { /* ignore */ }
      if (args) {
        const fp = args.file_path ?? args.filePath ?? args.path ?? args.file;
        if (typeof fp === 'string') paths.set(id, fp);
      }
    }
  }
}

/**
 * Before filtering tool_result messages from history, scan them for any file/image
 * content and attach those to the immediately following assistant message.
 * This mirrors channel push message behavior where tool outputs surface files to the UI.
 * Handles:
 *   - Image content blocks (base64 / url)
 *   - [media attached: path (mime) | path] text patterns in tool result output
 *   - Raw file paths in tool result text
 */
function enrichWithToolResultFiles(messages: RawMessage[]): RawMessage[] {
  const pending: AttachedFileMeta[] = [];
  const toolCallPaths = new Map<string, string>();

  return messages.map((msg) => {
    // Track file paths from assistant tool call arguments for later matching
    if (msg.role === 'assistant') {
      collectToolCallPaths(msg, toolCallPaths);
    }

    if (isToolResultRole(msg.role)) {
      // Resolve file path from the matching tool call
      const matchedPath = msg.toolCallId ? toolCallPaths.get(msg.toolCallId) : undefined;

      // 1. Image/file content blocks in the structured content array
      const imageFiles = extractImagesAsAttachedFiles(msg.content);
      if (matchedPath) {
        for (const f of imageFiles) {
          if (!f.filePath) {
            f.filePath = matchedPath;
            f.fileName = attachmentFileNameFromPath(matchedPath);
          }
        }
      }
      pending.push(...imageFiles.map((file) => withAttachedFileSource(file, 'tool-result')));

      // 2. [media attached: ...] patterns in tool result text output
      const text = getMessageText(msg.content);
      if (text) {
        const mediaRefs = extractMediaRefs(text);
        const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));
        for (const ref of mediaRefs) {
          pending.push(makeAttachedFile(ref, 'tool-result'));
        }
        // 3. Raw file paths in tool result text (documents, audio, video, etc.)
        for (const ref of extractRawFilePaths(text)) {
          if (!mediaRefPaths.has(ref.filePath)) {
            pending.push(makeAttachedFile(ref, 'tool-result'));
          }
        }
      }

      return msg; // will be filtered later
    }

    if (msg.role === 'assistant' && pending.length > 0) {
      const toAttach = pending.splice(0);
      // Deduplicate against files already on the assistant message
      const existingPaths = new Set(
        (msg._attachedFiles || []).map(f => f.filePath).filter(Boolean),
      );
      const newFiles = toAttach.filter(f => !f.filePath || !existingPaths.has(f.filePath));
      if (newFiles.length === 0) return msg;
      return {
        ...msg,
        _attachedFiles: [...(msg._attachedFiles || []), ...newFiles],
      };
    }

    return msg;
  });
}

/**
 * Restore _attachedFiles for messages loaded from history.
 * Handles:
 *   1. [media attached: path (mime) | path] patterns (attachment-button flow)
 *   2. Raw image file paths typed in message text (e.g. /Users/.../image.png)
 * Uses local cache for previews when available; missing previews are loaded async.
 */
function enrichWithCachedImages(messages: RawMessage[]): RawMessage[] {
  return messages.map((msg, idx) => {
    // Only process user and assistant messages; skip if already enriched
    if ((msg.role !== 'user' && msg.role !== 'assistant') || msg._attachedFiles) return msg;
    const text = getMessageText(msg.content);

    // Path 1: [media attached: path (mime) | path] — guaranteed format from attachment button
    const mediaRefs = extractMediaRefs(text);
    const mediaRefPaths = new Set(mediaRefs.map(r => r.filePath));

    // Path 2: Raw file paths.
    // For assistant messages: scan own text AND the nearest preceding user message text,
    // but only for non-tool-only assistant messages (i.e. the final answer turn).
    // Tool-only messages (thinking + tool calls) should not show file previews — those
    // belong to the final answer message that comes after the tool results.
    // User messages never get raw-path previews so the image is not shown twice.
    let rawRefs: Array<{ filePath: string; mimeType: string }> = [];
    if (msg.role === 'assistant' && !isToolOnlyMessage(msg)) {
      // Own text
      rawRefs = extractRawFilePaths(text).filter(r => !mediaRefPaths.has(r.filePath));

      // Nearest preceding user message text (look back up to 5 messages)
      const seenPaths = new Set(rawRefs.map(r => r.filePath));
      for (let i = idx - 1; i >= Math.max(0, idx - 5); i--) {
        const prev = messages[i];
        if (!prev) break;
        if (prev.role === 'user') {
          const prevText = getMessageText(prev.content);
          for (const ref of extractRawFilePaths(prevText)) {
            if (!mediaRefPaths.has(ref.filePath) && !seenPaths.has(ref.filePath)) {
              seenPaths.add(ref.filePath);
              rawRefs.push(ref);
            }
          }
          break; // only use the nearest user message
        }
      }
    }

    const allRefs = [...mediaRefs, ...rawRefs];
    if (allRefs.length === 0) return msg;

    const files: AttachedFileMeta[] = allRefs.map(ref => {
      const cached = _imageCache.get(ref.filePath);
      if (cached) return { ...cached, filePath: ref.filePath, source: 'message-ref' };
      const fileName = attachmentFileNameFromPath(ref.filePath);
      return { fileName, mimeType: ref.mimeType, fileSize: 0, preview: null, filePath: ref.filePath, source: 'message-ref' };
    });
    return { ...msg, _attachedFiles: files };
  });
}

/**
 * Async: load missing previews from disk via IPC for messages that have
 * _attachedFiles with null previews. Updates messages in-place and triggers re-render.
 * Handles both [media attached: ...] patterns and raw filePath entries.
 */
async function loadMissingPreviews(messages: RawMessage[]): Promise<boolean> {
  // Collect all image paths that need previews
  const needPreview: Array<{ filePath: string; mimeType: string }> = [];
  const seenPaths = new Set<string>();

  for (const msg of messages) {
    if (!msg._attachedFiles) continue;

    // Path 1: files with explicit filePath field (raw path detection or enriched refs)
    for (const file of msg._attachedFiles) {
      const fp = file.filePath;
      if (!fp || seenPaths.has(fp) || isVirtualMediaUri(fp)) continue;
      // Images: need preview. Non-images: need file size (for FileCard display).
      const needsLoad = file.mimeType.startsWith('image/')
        ? !file.preview
        : file.fileSize === 0;
      if (needsLoad) {
        seenPaths.add(fp);
        needPreview.push({ filePath: fp, mimeType: file.mimeType });
      }
    }

    // Path 2: [media attached: ...] patterns (legacy — in case filePath wasn't stored)
    if (msg.role === 'user') {
      const text = getMessageText(msg.content);
      const refs = extractMediaRefs(text);
      for (let i = 0; i < refs.length; i++) {
        const file = msg._attachedFiles[i];
        const ref = refs[i];
        if (!file || !ref || seenPaths.has(ref.filePath)) continue;
        const needsLoad = ref.mimeType.startsWith('image/') ? !file.preview : file.fileSize === 0;
        if (needsLoad) {
          seenPaths.add(ref.filePath);
          needPreview.push(ref);
        }
      }
    }
  }

  if (needPreview.length === 0) return false;

  try {
    const thumbnails = await invokeIpc(
      'media:getThumbnails',
      needPreview,
    ) as Record<string, { preview: string | null; fileSize: number }>;

    let updated = false;
    for (const msg of messages) {
      if (!msg._attachedFiles) continue;

      // Update files that have filePath
      for (const file of msg._attachedFiles) {
        const fp = file.filePath;
        if (!fp) continue;
        const thumb = thumbnails[fp];
        if (thumb && (thumb.preview || thumb.fileSize)) {
          if (thumb.preview) file.preview = thumb.preview;
          if (thumb.fileSize) file.fileSize = thumb.fileSize;
          _imageCache.set(fp, { ...file });
          updated = true;
        }
      }

      // Legacy: update by index for [media attached: ...] refs
      if (msg.role === 'user') {
        const text = getMessageText(msg.content);
        const refs = extractMediaRefs(text);
        for (let i = 0; i < refs.length; i++) {
          const file = msg._attachedFiles[i];
          const ref = refs[i];
          if (!file || !ref || file.filePath) continue; // skip if already handled via filePath
          const thumb = thumbnails[ref.filePath];
          if (thumb && (thumb.preview || thumb.fileSize)) {
            if (thumb.preview) file.preview = thumb.preview;
            if (thumb.fileSize) file.fileSize = thumb.fileSize;
            _imageCache.set(ref.filePath, { ...file });
            updated = true;
          }
        }
      }
    }
    if (updated) saveImageCache(_imageCache);
    return updated;
  } catch (err) {
    console.warn('[loadMissingPreviews] Failed:', err);
    return false;
  }
}

function getCanonicalPrefixFromSessions(sessions: ChatSession[]): string | null {
  const canonical = sessions.find((s) => s.key.startsWith('agent:'))?.key;
  if (!canonical) return null;
  const parts = canonical.split(':');
  if (parts.length < 2) return null;
  return `${parts[0]}:${parts[1]}`;
}

function isToolOnlyMessage(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (isToolResultRole(message.role)) return true;

  const msg = message as unknown as Record<string, unknown>;
  const content = message.content;

  // Check OpenAI-format tool_calls field (real-time streaming from OpenAI-compatible models)
  const toolCalls = msg.tool_calls ?? msg.toolCalls;
  const hasOpenAITools = Array.isArray(toolCalls) && toolCalls.length > 0;

  if (!Array.isArray(content)) {
    // Content is not an array — check if there's OpenAI-format tool_calls
    if (hasOpenAITools) {
      // Has tool calls but content might be empty/string — treat as tool-only
      // if there's no meaningful text content
      const textContent = typeof content === 'string' ? content.trim() : '';
      return textContent.length === 0;
    }
    return false;
  }

  let hasTool = hasOpenAITools;
  let hasText = false;
  let hasNonToolContent = false;

  for (const block of content as ContentBlock[]) {
    if (block.type === 'tool_use' || block.type === 'tool_result' || block.type === 'toolCall' || block.type === 'toolResult') {
      hasTool = true;
      continue;
    }
    if (block.type === 'text' && block.text && block.text.trim()) {
      hasText = true;
      continue;
    }
    // Only actual image output disqualifies a tool-only message.
    // Thinking blocks are internal reasoning that can accompany tool_use — they
    // should NOT prevent the message from being treated as an intermediate tool step.
    if (block.type === 'image') {
      hasNonToolContent = true;
    }
  }

  return hasTool && !hasText && !hasNonToolContent;
}

function isToolResultRole(role: unknown): boolean {
  if (!role) return false;
  const normalized = String(role).toLowerCase();
  return normalized === 'toolresult' || normalized === 'tool_result';
}

const CHANNEL_SEND_TOOL_PATTERN = /(?:message|dingtalk|chat|send|notify|im)(?:[_.-]|$)/i;

function pushChannelSendPayload(payloads: string[], input: Record<string, unknown>): void {
  for (const key of ['text', 'message', 'content', 'body', 'msg']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      payloads.push(value.trim());
    }
  }
}

function extractChannelSendPayloads(message: { role?: unknown; content?: unknown }): string[] {
  if (message.role !== 'assistant') return [];
  const payloads: string[] = [];
  const content = message.content;
  if (!Array.isArray(content)) return payloads;
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_use' && block.type !== 'toolCall' || !block.name) continue;
    if (!CHANNEL_SEND_TOOL_PATTERN.test(block.name)) continue;
    const rawInput = (block as ContentBlock & { input?: unknown; arguments?: unknown }).input
      ?? (block as ContentBlock & { arguments?: unknown }).arguments;
    if (typeof rawInput === 'string') {
      try {
        pushChannelSendPayload(payloads, JSON.parse(rawInput) as Record<string, unknown>);
      } catch {
        if (rawInput.trim()) payloads.push(rawInput.trim());
      }
    } else if (rawInput && typeof rawInput === 'object') {
      pushChannelSendPayload(payloads, rawInput as Record<string, unknown>);
    }
  }
  return payloads;
}

/** Short DingTalk/channel delivery acknowledgments that should not appear in desktop chat. */
function isChannelDeliveryConfirmationText(text: string): boolean {
  const normalized = stripSilentReplyToken(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  const patterns = [
    /^已通过钉钉.{0,32}发送[。.!！]?$/i,
    /^消息已通过钉钉发送[。.!！]?$/i,
    /^已.{0,8}向.{0,48}发送(?:消息)?[。.!！]?$/i,
    /^已向.{0,48}发送(?:消息)?[。.!！]?$/i,
    /^sent (?:the )?message (?:via|through) dingtalk[。.!]?$/i,
    /^message sent (?:via|through) dingtalk[。.!]?$/i,
  ];
  if (patterns.some((pattern) => pattern.test(normalized))) return true;
  if (/钉钉/.test(normalized) && /发送/.test(normalized) && normalized.length <= 96) return true;
  return false;
}

/** Hide assistant echoes of outbound channel payloads (e.g. DingTalk send-to-other-user). */
function isChannelOutboundEchoMessage(
  message: { role?: unknown; content?: unknown },
  allMessages: Array<{ role?: unknown; content?: unknown }>,
): boolean {
  if (message.role !== 'assistant') return false;
  const text = stripSilentReplyToken(getMessageText(message.content)).replace(/\s+/g, ' ').trim();
  if (!text || text.length > 2_000) return false;

  const messageIndex = allMessages.indexOf(message);
  const scanUntil = messageIndex >= 0 ? messageIndex : allMessages.length;
  const payloads: string[] = [];
  for (let i = 0; i < scanUntil; i += 1) {
    payloads.push(...extractChannelSendPayloads(allMessages[i]));
  }
  if (payloads.length === 0) return false;

  return payloads.some((payload) => {
    const normalizedPayload = payload.replace(/\s+/g, ' ').trim();
    if (!normalizedPayload) return false;
    return text === normalizedPayload
      || text.includes(normalizedPayload)
      || normalizedPayload.includes(text);
  });
}

function filterChannelOutboundEchoMessages<T extends { role?: unknown; content?: unknown }>(messages: T[]): T[] {
  return messages.filter((message) => !isChannelOutboundEchoMessage(message, messages));
}

function isInternalMessageText(text: string): boolean {
  const normalized = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/.test(normalized)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(normalized)) return true;
  if (/^\[LYCLAW internal tool failure feedback\]/i.test(normalized)) return true;
  if (/^\[LYCLAW internal convergence directive\]/i.test(normalized)) return true;
  if (containsSilentReplyToken(text) && stripSilentReplyToken(text).trim().length === 0) return true;
  if (isChannelDeliveryConfirmationText(text)) return true;
  if (/^\[?OpenClaw heartbeat poll\]?\s*$/i.test(text.trim())) return true;
  return isRuntimeSystemInjection(text);
}

/** Whether assistant text includes OpenClaw silent reply tokens. */
function containsSilentReplyToken(text: string): boolean {
  return /\b(?:NO_REPLY|HEARTBEAT_OK)\b/i.test(text);
}

/**
 * Remove OpenClaw silent reply tokens from assistant-visible text.
 * Common after messaging tools (e.g. DingTalk send): "已发送\\n\\nNO_REPLY".
 */
function stripSilentReplyToken(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(trimmed)) return '';
  // Leading silent token means the whole turn should stay hidden.
  if (/^\s*(?:NO_REPLY|HEARTBEAT_OK)\b/i.test(trimmed)) return '';
  return text.replace(/(?:\r?\n|\r|\s)*\b(?:NO_REPLY|HEARTBEAT_OK)\b\s*$/i, '').trimEnd();
}

/** True for internal plumbing messages that should never be shown in the UI. */
function isInternalMessage(msg: { role?: unknown; content?: unknown }): boolean {
  // 压缩后保留完整对话历史：不再无条件过滤 role=system，因为 OpenClaw 压缩时
  // 可能注入 system 角色的摘要，完全过滤会导致 UI 上所有 assistant 消息消失。
  // 只过滤明确的内部消息文本（heartbeat/NO_REPLY/审批提示等）。
  const text = getMessageText(msg.content);
  if ((msg.role === 'user' || msg.role === 'assistant') && isInternalMessageText(text)) return true;
  // system 消息现在也检查内容，避免把压缩摘要隐藏
  if (msg.role === 'system' && isInternalMessageText(text)) return true;
  return false;
}

/**
 * Detect runtime-injected system messages that should be hidden from the chat UI.
 * These are injected by the OpenClaw runtime as user-role messages and include:
 *   - "System (untrusted): ..." — exec results, tool output, etc.
 *   - "An async command ... has completed" — async completion notices
 *   - "Current time: ..." followed by nothing else — periodic heartbeat time pings
 *   - "Handle the result internally. Do not relay it to the user" — internal directives
 */
function isRuntimeSystemInjection(text: string): boolean {
  if (!text) return false;
  const normalized = text.trim();
  // "System (untrusted): ..." at the start (with optional leading whitespace)
  if (/^\s*System\s*\(untrusted\)\s*:/i.test(normalized)) return true;

  // 模型有时会把 Runtime 的审批协议当成普通回答说给用户看，例如
  // “请回复 /approve xxx 来放行”。审批权在 Main 安全策略，不应让这类话术进入聊天流。
  if (isModelCommandApprovalText(normalized)) return true;

  // 异步命令审批完成后，Runtime 会把继续执行提示以 user 消息写回 transcript。
  // 必须同时命中“异步完成”和“内部处理/不要重复执行”标记，避免误隐藏普通对话。
  if (
    /An async command (?:(?:you ran earlier|the user already approved) has completed|did not run)/i.test(normalized)
    && /(Do not relay it to the user unless explicitly requested|Do not run the command again|Continue the task if needed|Reply to the user in a helpful way|Explain that the command did not run)/i.test(normalized)
  ) {
    return true;
  }

  // Standalone time injection (e.g. "Current time: Wednesday, April 22nd, 2026 - 10:06 (Asia/Shanghai) / 2026-04-22 02:06 UTC")
  // Only match when the full message is the time announcement.
  if (
    /^\s*Current time\s*:/i.test(normalized)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/i.test(normalized)
  ) {
    return true;
  }

  return false;
}

function isModelCommandApprovalText(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (/\/approve\s+[a-z0-9_-]+/i.test(normalized) && normalized.length <= 160) return true;
  const hasApprovalIntent = /(?:需要|请).{0,12}(?:批准|准许|确认|允许).{0,12}(?:执行|运行|放行|命令|操作)/i.test(normalized)
    || /请\s*(?:批准|准许|确认|允许).{0,16}(?:初始化|生成|创建)/i.test(normalized)
    || /\b(?:approve|confirm|allow)\b.{0,24}\b(?:run|execute|command)\b/i.test(normalized);
  if (!hasApprovalIntent) return false;
  return /\/approve\s+[a-z0-9_-]+/i.test(normalized)
    || /\b(?:python3?|node|npm|pnpm|yarn|uv|uvx|dir|ls|cd|findstr|grep|Get-ChildItem|Select-String|powershell|cmd)(?:\s|$|[\\/])/i.test(normalized)
    || /[A-Za-z]:\\/.test(normalized);
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    }
  }
  return compactProgressiveTextParts(parts).join('\n');
}

function summarizeToolOutput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return undefined;
  const summaryLines = lines.slice(0, 2);
  let summary = summaryLines.join(' / ');
  if (summary.length > 160) {
    summary = `${summary.slice(0, 157)}...`;
  }
  return summary;
}

function normalizeToolStatus(rawStatus: unknown, fallback: 'running' | 'completed'): ToolStatus['status'] {
  const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : '';
  if (status === 'error' || status === 'failed') return 'error';
  if (status === 'completed' || status === 'success' || status === 'done') return 'completed';
  return fallback;
}

function parseDurationMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractToolUseUpdates(message: unknown): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const updates: ToolStatus[] = [];

  // Path 1: Anthropic/normalized format — tool blocks inside content array
  const content = msg.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if ((block.type !== 'tool_use' && block.type !== 'toolCall') || !block.name) continue;
      updates.push({
        id: block.id || block.name,
        toolCallId: block.id,
        name: block.name,
        status: 'running',
        updatedAt: Date.now(),
      });
    }
  }

  // Path 2: OpenAI format — tool_calls array on the message itself
  if (updates.length === 0) {
    const toolCalls = msg.tool_calls ?? msg.toolCalls;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls as Array<Record<string, unknown>>) {
        const fn = (tc.function ?? tc) as Record<string, unknown>;
        const name = typeof fn.name === 'string' ? fn.name : '';
        if (!name) continue;
        const id = typeof tc.id === 'string' ? tc.id : name;
        updates.push({
          id,
          toolCallId: typeof tc.id === 'string' ? tc.id : undefined,
          name,
          status: 'running',
          updatedAt: Date.now(),
        });
      }
    }
  }

  return updates;
}

function extractToolResultBlocks(message: unknown, eventState: string): ToolStatus[] {
  if (!message || typeof message !== 'object') return [];
  const msg = message as Record<string, unknown>;
  const content = msg.content;
  if (!Array.isArray(content)) return [];

  const updates: ToolStatus[] = [];
  for (const block of content as ContentBlock[]) {
    if (block.type !== 'tool_result' && block.type !== 'toolResult') continue;
    const outputText = extractTextFromContent(block.content ?? block.text ?? '');
    const summary = summarizeToolOutput(outputText);
    updates.push({
      id: block.id || block.name || 'tool',
      toolCallId: block.id,
      name: block.name || block.id || 'tool',
      status: normalizeToolStatus(undefined, eventState === 'delta' ? 'running' : 'completed'),
      summary,
      updatedAt: Date.now(),
    });
  }

  return updates;
}

function extractToolResultUpdate(message: unknown, eventState: string): ToolStatus | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, unknown>;
  const role = typeof msg.role === 'string' ? msg.role.toLowerCase() : '';
  if (!isToolResultRole(role)) return null;

  const toolName = typeof msg.toolName === 'string' ? msg.toolName : (typeof msg.name === 'string' ? msg.name : '');
  const toolCallId = typeof msg.toolCallId === 'string' ? msg.toolCallId : undefined;
  const details = (msg.details && typeof msg.details === 'object') ? msg.details as Record<string, unknown> : undefined;
  const rawStatus = (msg.status ?? details?.status);
  const fallback = eventState === 'delta' ? 'running' : 'completed';
  const status = normalizeToolStatus(rawStatus, fallback);
  const durationMs = parseDurationMs(details?.durationMs ?? details?.duration ?? (msg as Record<string, unknown>).durationMs);

  const outputText = (details && typeof details.aggregated === 'string')
    ? details.aggregated
    : extractTextFromContent(msg.content);
  const summary = summarizeToolOutput(outputText) ?? summarizeToolOutput(String(details?.error ?? msg.error ?? ''));

  const name = toolName || toolCallId || 'tool';
  const id = toolCallId || name;

  return {
    id,
    toolCallId,
    name,
    status,
    durationMs,
    summary,
    updatedAt: Date.now(),
  };
}

function mergeToolStatus(existing: ToolStatus['status'], incoming: ToolStatus['status']): ToolStatus['status'] {
  const order: Record<ToolStatus['status'], number> = { running: 0, completed: 1, error: 2 };
  return order[incoming] >= order[existing] ? incoming : existing;
}

function upsertToolStatuses(current: ToolStatus[], updates: ToolStatus[]): ToolStatus[] {
  if (updates.length === 0) return current;
  const next = [...current];
  for (const update of updates) {
    const key = update.toolCallId || update.id || update.name;
    if (!key) continue;
    const index = next.findIndex((tool) => (tool.toolCallId || tool.id || tool.name) === key);
    if (index === -1) {
      next.push(update);
      continue;
    }
    const existing = next[index];
    next[index] = {
      ...existing,
      ...update,
      name: update.name || existing.name,
      status: mergeToolStatus(existing.status, update.status),
      durationMs: update.durationMs ?? existing.durationMs,
      summary: update.summary ?? existing.summary,
      updatedAt: update.updatedAt || existing.updatedAt,
    };
  }
  return next;
}

function collectToolUpdates(message: unknown, eventState: string): ToolStatus[] {
  const updates: ToolStatus[] = [];
  const toolResultUpdate = extractToolResultUpdate(message, eventState);
  if (toolResultUpdate) updates.push(toolResultUpdate);
  updates.push(...extractToolResultBlocks(message, eventState));
  updates.push(...extractToolUseUpdates(message));
  return updates;
}

function hasNonToolAssistantContent(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string' && message.content.trim()) return true;

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text && block.text.trim()) return true;
      if (block.type === 'thinking' && block.thinking && block.thinking.trim()) return true;
      if (block.type === 'image') return true;
    }
  }

  const msg = message as unknown as Record<string, unknown>;
  if (typeof msg.text === 'string' && msg.text.trim()) return true;

  return false;
}

/** User-visible assistant output (text/image). Excludes thinking-only turns. */
function hasVisibleAssistantContent(message: RawMessage | undefined): boolean {
  if (!message) return false;
  if (typeof message.content === 'string') {
    const text = message.content.trim();
    return Boolean(text) && !isInternalMessageText(text);
  }

  const content = message.content;
  if (Array.isArray(content)) {
    for (const block of content as ContentBlock[]) {
      if (block.type === 'text' && block.text?.trim() && !isInternalMessageText(block.text)) {
        return true;
      }
      if (block.type === 'image') return true;
    }
  }

  const msg = message as unknown as Record<string, unknown>;
  if (typeof msg.text === 'string' && msg.text.trim() && !isInternalMessageText(msg.text)) {
    return true;
  }

  return false;
}

function setHistoryPollTimer(timer: ReturnType<typeof setTimeout> | null): void {
  _historyPollTimer = timer;
}

function hasErrorRecoveryTimer(): boolean {
  return _errorRecoveryTimer != null;
}

function setErrorRecoveryTimer(timer: ReturnType<typeof setTimeout> | null): void {
  _errorRecoveryTimer = timer;
}

function setLastChatEventAt(value: number): void {
  _lastChatEventAt = value;
}

function getLastChatEventAt(): number {
  return _lastChatEventAt;
}

export {
  toMs,
  clearErrorRecoveryTimer,
  clearHistoryPoll,
  markAbortHistoryQuietPeriod,
  isAbortHistoryQuietPeriod,
  extractImagesAsAttachedFiles,
  getMessageText,
  stripGatewayUserMetadata,
  extractMediaRefs,
  extractRawFilePaths,
  makeAttachedFile,
  enrichWithToolResultFiles,
  isInternalMessage,
  isInternalMessageText,
  isChannelDeliveryConfirmationText,
  isChannelOutboundEchoMessage,
  filterChannelOutboundEchoMessages,
  stripSilentReplyToken,
  isToolResultRole,
  enrichWithCachedImages,
  normalizeComplexTaskControlUserMessages,
  loadMissingPreviews,
  upsertImageCacheEntry,
  getCanonicalPrefixFromSessions,
  getToolCallFilePath,
  collectToolUpdates,
  upsertToolStatuses,
  hasNonToolAssistantContent,
  hasVisibleAssistantContent,
  isToolOnlyMessage,
  normalizeStreamingMessage,
  matchesOptimisticUserMessage,
  snapshotStreamingAssistantMessage,
  getLatestOptimisticUserMessage,
  setHistoryPollTimer,
  hasErrorRecoveryTimer,
  setErrorRecoveryTimer,
  setLastChatEventAt,
  getLastChatEventAt,
};
