/**
 * Renderer-facing usage reporting client.
 *
 * Forwards events to main-process queue via host-api. All errors are
 * swallowed (telemetry-style): a record-time failure must never break
 * chat / install / message flow. Records are queued in main-process
 * electron-store and uploaded by the scheduler / home-entry trigger.
 */

import { hostApiFetch } from './host-api';

/** 技能 ID/slug 到名称的映射 */
let skillNameMap: Map<string, string> = new Map();

/**
 * 更新技能名称映射
 */
export function updateSkillNameMap(skills: Array<{ id?: string; slug?: string; name: string }>): void {
  skillNameMap.clear();
  for (const skill of skills) {
    if (skill.id) skillNameMap.set(skill.id, skill.name);
    if (skill.slug) skillNameMap.set(skill.slug, skill.name);
  }
}

/**
 * 根据技能 ID/slug 获取技能名称，如果找不到则返回原 ID
 */
function getSkillName(skillId: string): string {
  return skillNameMap.get(skillId) || skillId;
}

export interface ChannelDiagnostic {
  channel: 'tokenConsume' | 'skillDownload' | 'skillInvoke';
  url: string;
  method: 'POST';
  count: number;
  requestBody: string;
  status: number | null;
  statusText: string | null;
  durationMs: number;
  responseBody: string | null;
  error: string | null;
}

export interface FlushResult {
  success: boolean;
  uploaded?: {
    tokenConsume: number;
    skillDownload: number;
    skillInvoke: number;
  };
  errors?: {
    tokenConsume: string | null;
    skillDownload: string | null;
    skillInvoke: string | null;
  };
  /** Per-channel request/response trace, mirrored from main for DevTools. */
  diagnostics?: ChannelDiagnostic[];
}

function logDiagnostics(reason: string, diagnostics: ChannelDiagnostic[] | undefined): void {
  if (!diagnostics || diagnostics.length === 0) return;
  // eslint-disable-next-line no-console -- intentional dev-visibility logging.
  console.groupCollapsed(`[UsageReport] flush(${reason}) — ${diagnostics.length} channel(s)`);
  for (const d of diagnostics) {
    const head = `${d.method} ${d.url} → ${d.status ?? '(no response)'} ${d.statusText ?? ''} (${d.durationMs}ms, count=${d.count})`;
    if (d.error) {
      // eslint-disable-next-line no-console
      console.error(`[UsageReport][${d.channel}] ${head}`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`[UsageReport][${d.channel}] ${head}`);
    }
    // eslint-disable-next-line no-console
    console.log('  request body:', d.requestBody);
    // eslint-disable-next-line no-console
    console.log('  response body:', d.responseBody);
  }
  // eslint-disable-next-line no-console
  console.groupEnd();
}

function safeNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export async function reportTokenConsume(model: string, consume: number): Promise<void> {
  const trimmedModel = (model || '').trim();
  const safeConsume = safeNumber(consume);
  if (!trimmedModel || safeConsume === null || safeConsume <= 0) return;
  try {
    await hostApiFetch('/api/usage-report/token-consume', {
      method: 'POST',
      body: JSON.stringify({ model: trimmedModel, consume: Math.floor(safeConsume) }),
    });
  } catch (error) {
    console.warn('[UsageReport] queue token-consume failed (non-fatal):', error);
  }
}

export async function reportSkillDownload(skillId: string, count = 1): Promise<void> {
  const trimmedSkillId = (skillId || '').trim();
  if (!trimmedSkillId) return;
  const skillName = getSkillName(trimmedSkillId);
  try {
    await hostApiFetch('/api/usage-report/skill-download', {
      method: 'POST',
      body: JSON.stringify({ skillId: skillName, count }),
    });
  } catch (error) {
    console.warn('[UsageReport] queue skill-download failed (non-fatal):', error);
  }
}

export async function reportSkillInvoke(skillId: string, count = 1): Promise<void> {
  const trimmedSkillId = (skillId || '').trim();
  if (!trimmedSkillId) return;
  const skillName = getSkillName(trimmedSkillId);
  try {
    await hostApiFetch('/api/usage-report/skill-invoke', {
      method: 'POST',
      body: JSON.stringify({ skillId: skillName, count }),
    });
  } catch (error) {
    console.warn('[UsageReport] queue skill-invoke failed (non-fatal):', error);
  }
}

export async function flushUsageReports(reason: string): Promise<FlushResult> {
  try {
    const result = await hostApiFetch<FlushResult>('/api/usage-report/flush', {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    // Mirror main-process diagnostics to DevTools so devs can copy-paste the
    // exact failing request without tailing the userData log file.
    logDiagnostics(reason, result.diagnostics);
    return result;
  } catch (error) {
    console.warn('[UsageReport] flush failed (non-fatal):', error);
    return { success: false };
  }
}
