import type { SkillInvokeRecord } from './types';

/** Backend POST body for `/management/claw/report/skill-invoke` (camelCase). */
export interface SkillInvokeUploadPayload {
  createBy?: string;
  createDate?: string;
  updateBy?: string;
  updateDate?: string;
  executionId?: string;
  workNo: string;
  agentId?: string;
  skillId: string;
  skillSource?: string;
  invokeMode?: string;
  invokeTime: string;
  invokeEndTime?: string;
  status?: string;
  errorMessage?: string;
}

export function toSkillInvokeUploadPayload(record: SkillInvokeRecord): SkillInvokeUploadPayload {
  const invokeTime = (record.invoke_time || record.invokeTime || '').trim();
  const payload: SkillInvokeUploadPayload = {
    workNo: (record.workNo || '').trim(),
    skillId: (record.skillId || '').trim(),
    invokeTime: invokeTime || record.invokeTime,
  };

  if (record.create_by) payload.createBy = record.create_by;
  if (record.create_date) payload.createDate = record.create_date;
  if (record.update_by) payload.updateBy = record.update_by;
  if (record.update_date) payload.updateDate = record.update_date;
  if (record.execution_id) payload.executionId = record.execution_id;
  if (record.agent_id) payload.agentId = record.agent_id;
  if (record.skill_source) payload.skillSource = record.skill_source;
  if (record.invoke_mode) payload.invokeMode = record.invoke_mode;
  if (record.invoke_end_time) payload.invokeEndTime = record.invoke_end_time;
  if (record.status) payload.status = record.status;
  if (record.error_message) payload.errorMessage = record.error_message;

  return payload;
}

export function toSkillInvokeUploadPayloads(records: SkillInvokeRecord[]): SkillInvokeUploadPayload[] {
  return records.map(toSkillInvokeUploadPayload);
}
