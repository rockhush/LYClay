import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { toOpenClawChannelType } from '../utils/channel-alias';
import { getOpenClawConfigDir } from '../utils/paths';
import { logger } from '../utils/logger';
import type { SessionDeliveryContext } from '../utils/session-delivery-context';
import { appendCronRunLogEntry } from './cron-run-log';

type GatewayRpc = <T>(method: string, params?: unknown, timeoutMs?: number) => Promise<T>;

export interface ExternalCronDeliveryPending {
  jobId: string;
  runSessionId: string;
  sessionKey: string;
  runId: string;
  agentId: string;
  taskMessage: string;
  deliveryContext: SessionDeliveryContext;
  registeredAtMs: number;
}

const pendingByRunId = new Map<string, ExternalCronDeliveryPending>();
const deliveredRunIds = new Set<string>();

const RECIPIENT_CLARIFICATION_RE = /(?:发给谁|发送给谁|接收人|收件人|who (?:do you|should I) send|recipient|send (?:this )?to whom)/i;

export function parseScheduledTaskSessionKey(sessionKey: string): { jobId: string; runSessionId: string } | null {
  if (!sessionKey.startsWith('agent:')) return null;
  const parts = sessionKey.split(':');
  if (parts.length < 5 || parts[2] !== 'scheduled-task') return null;
  const jobId = parts[3]?.trim();
  const runSessionId = parts[4]?.trim();
  if (!jobId || !runSessionId) return null;
  return { jobId, runSessionId };
}

export function isScheduledTaskSessionKey(sessionKey: string): boolean {
  return parseScheduledTaskSessionKey(sessionKey) != null;
}

/** In-app-only guidance for external cron first turns; host delivers after the run completes. */
export function buildScheduledTaskInAppSystemPrompt(): string {
  return [
    '## Scheduled task (LYClaw in-app execution)',
    'This automated scheduled task runs inside LYClaw only.',
    'Answer the user task normally in this chat.',
    'Do NOT use the `message` tool or any outbound channel send tool.',
    'Do NOT ask who to send to — external delivery is handled automatically by LYClaw after you finish.',
  ].join('\n');
}

export function registerExternalCronDeliveryPending(pending: ExternalCronDeliveryPending): void {
  pendingByRunId.set(pending.runId, pending);
}

export function getExternalCronDeliveryPending(runId: string): ExternalCronDeliveryPending | undefined {
  return pendingByRunId.get(runId);
}

function getMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return '';
  const record = message as Record<string, unknown>;
  const direct = record.content ?? record.text;
  if (typeof direct === 'string') return direct.trim();
  if (!Array.isArray(direct)) return '';
  return direct.map((block) => {
    if (!block || typeof block !== 'object') return '';
    const item = block as Record<string, unknown>;
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string') return item.content;
    return '';
  }).filter(Boolean).join('\n').trim();
}

export function looksLikeRecipientClarification(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return RECIPIENT_CLARIFICATION_RE.test(trimmed);
}

export function resolveExternalCronDeliveryText(
  assistantText: string | undefined,
  taskMessage: string,
): string {
  const candidate = assistantText?.trim() ?? '';
  if (candidate && !looksLikeRecipientClarification(candidate)) {
    return candidate;
  }
  return taskMessage.trim() || candidate;
}

async function readLatestAssistantTextFromTranscript(sessionKey: string): Promise<string | undefined> {
  const parts = sessionKey.split(':');
  const agentId = parts[1]?.trim();
  if (!agentId) return undefined;

  const sessionsPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', 'sessions.json');
  let transcriptPath: string | undefined;
  try {
    const raw = await readFile(sessionsPath, 'utf8');
    if (!raw.trim()) return undefined;
    const store = JSON.parse(raw) as Record<string, unknown>;
    const entry = store[sessionKey];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>;
      const sessionFile = typeof record.sessionFile === 'string' ? record.sessionFile : undefined;
      const id = typeof record.id === 'string' ? record.id : undefined;
      if (sessionFile) {
        transcriptPath = sessionFile;
      } else if (id) {
        transcriptPath = join(getOpenClawConfigDir(), 'agents', agentId, 'sessions', `${id}.jsonl`);
      }
    }
  } catch {
    return undefined;
  }

  if (!transcriptPath) {
    const parsed = parseScheduledTaskSessionKey(sessionKey);
    if (parsed) {
      transcriptPath = join(
        getOpenClawConfigDir(),
        'agents',
        agentId,
        'sessions',
        `${parsed.runSessionId}.jsonl`,
      );
    }
  }

  if (!transcriptPath) return undefined;

  try {
    const raw = await readFile(transcriptPath, 'utf8');
    if (!raw.trim()) return undefined;
    let latest: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { type?: string; message?: unknown };
        if (entry.type !== 'message' || !entry.message) continue;
        const message = entry.message as { role?: unknown; content?: unknown };
        if (typeof message.role !== 'string' || message.role.toLowerCase() !== 'assistant') continue;
        const text = getMessageText(message);
        if (text) latest = text;
      } catch {
        // ignore malformed lines
      }
    }
    return latest;
  } catch {
    return undefined;
  }
}

async function deliverExternalCronResult(
  rpc: GatewayRpc,
  pending: ExternalCronDeliveryPending,
  deliveryText: string,
): Promise<void> {
  const channel = toOpenClawChannelType(pending.deliveryContext.channel);
  const params: Record<string, unknown> = {
    channel,
    to: pending.deliveryContext.to,
    message: deliveryText,
    agentId: pending.agentId,
    sessionKey: pending.sessionKey,
    idempotencyKey: `cron-external-delivery-${pending.jobId}-${pending.runSessionId}`,
  };
  if (pending.deliveryContext.accountId) {
    params.accountId = pending.deliveryContext.accountId;
  }

  await rpc('send', params, 60_000);
}

export async function handleExternalCronChatTerminal(args: {
  rpc: GatewayRpc;
  runId: string;
  sessionKey?: string;
  state: string;
  message?: unknown;
}): Promise<void> {
  const pending = pendingByRunId.get(args.runId);
  if (!pending) return;
  if (args.sessionKey && pending.sessionKey !== args.sessionKey) return;
  if (deliveredRunIds.has(args.runId)) return;

  pendingByRunId.delete(args.runId);
  deliveredRunIds.add(args.runId);

  if (args.state !== 'final') {
    logger.info('[cron-external-delivery] skipped delivery for non-final run', {
      runId: args.runId,
      sessionKey: pending.sessionKey,
      state: args.state,
    });
    return;
  }

  const eventText = getMessageText(args.message);
  let assistantText = eventText || undefined;
  if (!assistantText || looksLikeRecipientClarification(assistantText)) {
    assistantText = await readLatestAssistantTextFromTranscript(pending.sessionKey);
  }
  const deliveryText = resolveExternalCronDeliveryText(assistantText, pending.taskMessage);
  if (!deliveryText.trim()) {
    logger.warn('[cron-external-delivery] no delivery text available', {
      runId: args.runId,
      sessionKey: pending.sessionKey,
      state: args.state,
    });
    await appendCronRunLogEntry(pending.jobId, {
      status: 'error',
      error: 'External delivery skipped: no deliverable text from scheduled task run.',
      sessionId: pending.runSessionId,
      sessionKey: pending.sessionKey,
      runId: pending.runId,
      source: 'external-delivery',
    }).catch(() => {});
    return;
  }

  try {
    await deliverExternalCronResult(args.rpc, pending, deliveryText);
    logger.info('[cron-external-delivery] delivered scheduled task result', {
      runId: args.runId,
      sessionKey: pending.sessionKey,
      channel: pending.deliveryContext.channel,
      to: pending.deliveryContext.to,
    });
    await appendCronRunLogEntry(pending.jobId, {
      status: 'ok',
      summary: `Delivered scheduled task result to ${pending.deliveryContext.channel}:${pending.deliveryContext.to}.`,
      sessionId: pending.runSessionId,
      sessionKey: pending.sessionKey,
      runId: pending.runId,
      source: 'external-delivery',
    }).catch(() => {});
  } catch (error) {
    logger.warn('[cron-external-delivery] delivery failed', {
      runId: args.runId,
      sessionKey: pending.sessionKey,
      error: String(error),
    });
    await appendCronRunLogEntry(pending.jobId, {
      status: 'error',
      error: `External delivery failed: ${String(error)}`,
      sessionId: pending.runSessionId,
      sessionKey: pending.sessionKey,
      runId: pending.runId,
      source: 'external-delivery',
    }).catch(() => {});
  }
}

/** Test helper */
export function clearExternalCronDeliveryState(): void {
  pendingByRunId.clear();
  deliveredRunIds.clear();
}
