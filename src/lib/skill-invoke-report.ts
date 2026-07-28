import type { RawMessage } from '@/stores/chat/types';
import { normalizeTimestampToMs } from '@/pages/Chat/message-utils';
import type { SkillInvokeReportInput } from '@/lib/usage-reporter';
import {
  normalizeSkillInvokeReportSource,
  type SkillInvokeReportSource,
} from '../../shared/reporting/skill-invoke-source';

type SkillLike = {
  id?: string;
  slug?: string;
  source?: string;
  name?: string;
  isBundled?: boolean;
  isCore?: boolean;
  baseDir?: string;
  downloads?: number;
};

export function resolveSkillSource(skillId: string, skills: SkillLike[]): SkillInvokeReportSource {
  const trimmed = skillId.trim();
  if (!trimmed) return 'local';
  const match = skills.find((skill) =>
    skill.id === trimmed || skill.slug === trimmed || skill.name === trimmed,
  );
  return normalizeSkillInvokeReportSource(match?.source, {
    isBundled: match?.isBundled,
    isCore: match?.isCore,
    baseDir: match?.baseDir,
    numericMarketplaceId: /^\d+$/.test(trimmed),
    hasDownloads: typeof match?.downloads === 'number' && match.downloads > 0,
  });
}

export function formatSkillInvokeDateTimeMs(ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')} ${pick('hour')}:${pick('minute')}:${pick('second')}`;
}

export function resolveMessageDateTime(message: RawMessage | undefined): string | undefined {
  if (!message) return undefined;
  const ms = normalizeTimestampToMs(message.timestamp);
  return ms != null ? formatSkillInvokeDateTimeMs(ms) : undefined;
}

export function buildReadSkillInvokeReport(input: {
  skillId: string;
  skills: SkillLike[];
  executionId: string;
  agentId: string;
  sessionStartedAtMs: number | null;
  invokeMode: 'user_selected' | 'model_selected';
  invokeTimeMs: number;
  invokeEndTimeMs: number;
  status: 'success' | 'failed' | 'cancelled';
  errorMessage?: string;
}): SkillInvokeReportInput {
  const invokeTime = formatSkillInvokeDateTimeMs(input.invokeTimeMs);
  const invokeEndTime = formatSkillInvokeDateTimeMs(input.invokeEndTimeMs);
  const createDate = input.sessionStartedAtMs != null
    ? formatSkillInvokeDateTimeMs(input.sessionStartedAtMs)
    : invokeTime;
  return {
    skillId: input.skillId,
    count: 1,
    execution_id: input.executionId,
    agent_id: input.agentId,
    skill_source: resolveSkillSource(input.skillId, input.skills),
    invoke_mode: input.invokeMode,
    invoke_time: invokeTime,
    invoke_end_time: invokeEndTime,
    status: input.status,
    error_message: input.errorMessage,
    create_date: createDate,
    update_date: invokeEndTime,
  };
}

export function buildFailedSkillInvokeReport(input: {
  skillId: string;
  skills: SkillLike[];
  executionId: string;
  agentId: string;
  sessionStartedAtMs: number | null;
  invokeMode: 'user_selected' | 'model_selected';
  invokeTimeMs: number;
  invokeEndTimeMs: number;
  errorMessage?: string;
}): SkillInvokeReportInput {
  return buildReadSkillInvokeReport({
    ...input,
    status: 'failed',
    errorMessage: input.errorMessage ?? 'Skill read step was not observed',
  });
}

export function buildUserSelectedSkillInvokeReport(input: {
  skillId: string;
  skills: SkillLike[];
  executionId: string | null;
  agentId: string;
  sessionStartedAtMs: number | null;
  startedAtMs: number;
  nowMs?: number;
}): SkillInvokeReportInput {
  const nowMs = input.nowMs ?? Date.now();
  const invokeTime = formatSkillInvokeDateTimeMs(nowMs);
  const createDate = input.sessionStartedAtMs != null
    ? formatSkillInvokeDateTimeMs(input.sessionStartedAtMs)
    : invokeTime;
  return {
    skillId: input.skillId,
    count: 1,
    execution_id: input.executionId ?? undefined,
    agent_id: input.agentId,
    skill_source: resolveSkillSource(input.skillId, input.skills),
    invoke_mode: 'user_selected',
    invoke_time: invokeTime,
    status: 'unknown',
    create_date: createDate,
    update_date: invokeTime,
  };
}

export function buildModelSelectedSkillInvokeReport(input: {
  skillId: string;
  skills: SkillLike[];
  executionId: string | null;
  agentId: string;
  sessionStartedAtMs: number | null;
  message?: RawMessage;
  runAborted?: boolean;
  errorMessage?: string;
  nowMs?: number;
}): SkillInvokeReportInput {
  const nowMs = input.nowMs ?? Date.now();
  const invokeTime = resolveMessageDateTime(input.message) ?? formatSkillInvokeDateTimeMs(nowMs);
  const createDate = input.sessionStartedAtMs != null
    ? formatSkillInvokeDateTimeMs(input.sessionStartedAtMs)
    : invokeTime;
  const runAborted = Boolean(input.runAborted);
  const status = runAborted ? 'cancelled' : 'success';
  return {
    skillId: input.skillId,
    count: 1,
    execution_id: input.executionId ?? undefined,
    agent_id: input.agentId,
    skill_source: resolveSkillSource(input.skillId, input.skills),
    invoke_mode: 'model_selected',
    invoke_time: invokeTime,
    invoke_end_time: invokeTime,
    status,
    error_message: runAborted ? (input.errorMessage?.trim() || undefined) : undefined,
    create_date: createDate,
    update_date: invokeTime,
  };
}
