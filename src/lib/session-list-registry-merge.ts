import { isUserFacingSessionKey } from '@/lib/session-key-utils';
import { isPlaceholderSessionTitle } from '@/lib/session-label-utils';
import type { ChatSession } from '@/stores/chat/types';

export interface SessionRegistryRetentionContext {
  sessionLabels: Record<string, string>;
  customSessionLabels: Record<string, string>;
  sessionLastActivity: Record<string, number>;
  sessionWorkspaceIds: Record<string, string>;
  sessionPinnedAt: Record<string, number>;
}

/** Whether a sessions.json entry should stay on the sidebar when Gateway omits it. */
export function sessionHasRegistryRetentionSignals(
  session: ChatSession,
  ctx: SessionRegistryRetentionContext,
): boolean {
  const key = session.key;
  if (ctx.customSessionLabels[key]?.trim()) return true;
  if (ctx.sessionLabels[key]?.trim()) return true;
  if (typeof ctx.sessionLastActivity[key] === 'number' && ctx.sessionLastActivity[key] > 0) return true;
  if (ctx.sessionWorkspaceIds[key]) return true;
  if (typeof ctx.sessionPinnedAt[key] === 'number' && ctx.sessionPinnedAt[key] > 0) return true;
  if (session.firstUserMessagePreview?.trim()) return true;
  if (session.label?.trim() && !isPlaceholderSessionTitle(session.label)) return true;
  if (typeof session.lastMessageAt === 'number' && session.lastMessageAt > 0) return true;
  return false;
}

/**
 * Gateway `sessions.list` can briefly omit registered sessions on cold start.
 * Union in user-facing local registry rows that carry real conversation signals.
 */
export function unionGatewaySessionsWithLocalRegistry(
  gatewaySessions: ChatSession[],
  localSessions: ChatSession[],
  ctx: SessionRegistryRetentionContext,
): ChatSession[] {
  const keySet = new Set(gatewaySessions.map((session) => session.key));
  const out = [...gatewaySessions];
  for (const local of localSessions) {
    if (keySet.has(local.key)) continue;
    if (!isUserFacingSessionKey(local.key)) continue;
    if (!sessionHasRegistryRetentionSignals(local, ctx)) continue;
    keySet.add(local.key);
    out.push(local);
  }
  return out;
}
