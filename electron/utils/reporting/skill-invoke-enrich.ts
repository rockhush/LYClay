import { parseReportDateTimeMs } from '../../../shared/reporting/diagnostic-pick';
import { normalizeSkillInvokeReportSource } from '../../../shared/reporting/skill-invoke-source';
import { buildSkillInvokeAgentNameLookup } from './skill-invoke-agent-id-lookup';
import { finalizeSkillInvokeRecord } from './queue';
import type { ExecutionRecord, SkillInvokeRecord } from './types';

function normalizeAuditKey(value: string | undefined): string {
  return (value ?? '').trim();
}

function linkExecutionId(
  record: SkillInvokeRecord,
  executions: ExecutionRecord[],
): string | undefined {
  const invokeMs = parseReportDateTimeMs(record.invoke_time ?? record.invokeTime);
  if (invokeMs == null) return undefined;
  const recordWork = normalizeAuditKey(record.create_by || record.workNo);

  let best: ExecutionRecord | null = null;
  let bestDistance = Infinity;
  for (const execution of executions) {
    const executionWork = normalizeAuditKey(execution.create_by || execution.work_no);
    if (recordWork && executionWork && recordWork !== executionWork) continue;

    const startedMs = parseReportDateTimeMs(execution.started_at);
    if (startedMs == null) continue;
    const endedMs = parseReportDateTimeMs(execution.ended_at) ?? startedMs;
    const windowEnd = Math.max(endedMs, startedMs) + 5_000;
    if (invokeMs < startedMs - 5_000 || invokeMs > windowEnd) continue;

    const distance = Math.abs(invokeMs - startedMs);
    if (distance < bestDistance) {
      best = execution;
      bestDistance = distance;
    }
  }
  return best?.execution_id?.trim() || undefined;
}

function statusRank(status: string | undefined): number {
  if (status === 'success') return 4;
  if (status === 'failed') return 3;
  if (status === 'cancelled') return 2;
  if (status === 'unknown') return 1;
  return 0;
}

function dedupeKey(record: SkillInvokeRecord): string {
  const executionId = (record.execution_id || '').trim();
  const skillId = (record.skillId || '').trim().toLowerCase();
  if (executionId) return `${executionId}::${skillId}`;
  const invokeTime = (record.invoke_time || record.invokeTime || '').trim();
  return `${invokeTime}::${skillId}`;
}

function shouldReplaceSkillInvokeRecord(
  current: SkillInvokeRecord,
  candidate: SkillInvokeRecord,
): boolean {
  const currentRank = statusRank(current.status);
  const candidateRank = statusRank(candidate.status);
  if (candidateRank !== currentRank) return candidateRank > currentRank;

  const currentHasEnd = Boolean((current.invoke_end_time || '').trim());
  const candidateHasEnd = Boolean((candidate.invoke_end_time || '').trim());
  if (candidateHasEnd !== currentHasEnd) return candidateHasEnd;

  const currentMs = parseReportDateTimeMs(current.update_date ?? current.invoke_time ?? current.invokeTime) ?? 0;
  const candidateMs = parseReportDateTimeMs(candidate.update_date ?? candidate.invoke_time ?? candidate.invokeTime) ?? 0;
  return candidateMs >= currentMs;
}

function isUploadableSkillInvokeRecord(record: SkillInvokeRecord): boolean {
  const status = (record.status || 'unknown').trim();
  const hasEnd = Boolean((record.invoke_end_time || '').trim());
  const mode = record.invoke_mode || 'user_selected';
  if (mode === 'model_selected' && status === 'unknown' && !hasEnd) return false;
  return true;
}

export function dedupeSkillInvokeRecordsForUpload(records: SkillInvokeRecord[]): SkillInvokeRecord[] {
  const byKey = new Map<string, SkillInvokeRecord>();
  for (const record of records) {
    if (!isUploadableSkillInvokeRecord(record)) continue;
    const finalized = finalizeSkillInvokeRecord(record);
    const key = dedupeKey(finalized);
    const existing = byKey.get(key);
    if (!existing || shouldReplaceSkillInvokeRecord(existing, finalized)) {
      byKey.set(key, finalized);
    }
  }
  return [...byKey.values()].sort((a, b) => {
    const aMs = parseReportDateTimeMs(a.update_date ?? a.invoke_time ?? a.invokeTime) ?? 0;
    const bMs = parseReportDateTimeMs(b.update_date ?? b.invoke_time ?? b.invokeTime) ?? 0;
    return aMs - bMs;
  });
}

export async function enrichSkillInvokeRecordsForUpload(
  records: SkillInvokeRecord[],
  executions: ExecutionRecord[],
): Promise<SkillInvokeRecord[]> {
  const agentNameLookup = records.length > 0
    ? await buildSkillInvokeAgentNameLookup()
    : new Map<string, string>();
  const deduped = dedupeSkillInvokeRecordsForUpload(records);
  return deduped.map((record) => {
    let finalized = finalizeSkillInvokeRecord(record);
    if (!finalized.execution_id?.trim()) {
      const linked = linkExecutionId(finalized, executions);
      if (linked) finalized = { ...finalized, execution_id: linked };
    }
    const rawAgentId = (finalized.agent_id ?? '').trim();
    const displayName = agentNameLookup.get(rawAgentId);
    if (displayName) {
      finalized = { ...finalized, agent_id: displayName };
      if (finalized.skill_source === 'local') {
        finalized = {
          ...finalized,
          skill_source: normalizeSkillInvokeReportSource('digital_employee'),
        };
      }
    }
    return finalized;
  });
}
