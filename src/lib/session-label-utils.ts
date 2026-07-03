import { rewriteRuntimeSkillMentionsToDisplayInText } from '@/lib/skill-runtime-aliases';
import type { Skill } from '@/types/skill';

const PLACEHOLDER_SESSION_TITLES = new Set([
  'lyclaw',
  'lyclaw ui',
]);

type SessionLabelSkill = Pick<Skill, 'id' | 'slug' | 'name'>;

function stripThinkingDirective(value: string): string {
  return value.replace(/\/think\s+(off|medium|high)\s+/i, '').trim();
}

export function formatSessionPreviewForDisplay(
  value: string | undefined | null,
  skills: readonly SessionLabelSkill[] = [],
): string | undefined {
  const trimmed = stripThinkingDirective(value || '');
  if (!trimmed) return undefined;
  return rewriteRuntimeSkillMentionsToDisplayInText(trimmed, skills);
}

export function normalizeSessionSummaryForDisplay(
  session: {
    label?: string;
    firstUserMessagePreview?: string;
    displayName?: string;
  },
  skills: readonly SessionLabelSkill[] = [],
): typeof session {
  const rewrite = (value?: string) => {
    if (!value?.trim()) return value;
    const next = formatSessionPreviewForDisplay(value, skills);
    return next && next !== stripThinkingDirective(value) ? next : value;
  };

  const firstUserMessagePreview = rewrite(session.firstUserMessagePreview);
  const label = rewrite(session.label);
  const displayName = rewrite(session.displayName);

  if (
    firstUserMessagePreview === session.firstUserMessagePreview
    && label === session.label
    && displayName === session.displayName
  ) {
    return session;
  }

  return {
    ...session,
    ...(firstUserMessagePreview !== undefined ? { firstUserMessagePreview } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

export function isPlaceholderSessionTitle(value: string | undefined | null): boolean {
  if (!value?.trim()) return true;
  const trimmed = value.trim();
  if (PLACEHOLDER_SESSION_TITLES.has(trimmed.toLowerCase())) return true;
  if (trimmed.startsWith('agent:')) return true;
  return false;
}

export function resolveSessionDisplayLabel(params: {
  sessionKey: string;
  customLabel?: string;
  sessionLabel?: string;
  firstUserMessagePreview?: string;
  label?: string;
  displayName?: string;
  skills?: readonly SessionLabelSkill[];
}): string {
  const candidates = [
    params.customLabel,
    params.sessionLabel,
    params.firstUserMessagePreview,
    params.label,
    params.displayName,
    params.sessionKey,
  ];

  for (const candidate of candidates) {
    const cleaned = formatSessionPreviewForDisplay(candidate, params.skills);
    if (!cleaned || !cleaned.trim()) continue;
    if (!isPlaceholderSessionTitle(cleaned)) {
      return cleaned;
    }
  }

  return params.sessionKey;
}

export function collectAgentIdsFromSessionKeys(sessionKeys: string[]): string[] {
  const ids = new Set<string>(['main']);
  for (const sessionKey of sessionKeys) {
    if (!sessionKey.startsWith('agent:')) continue;
    const [, agentId] = sessionKey.split(':');
    if (agentId) ids.add(agentId);
  }
  return [...ids];
}
