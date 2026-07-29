import type { ExecutionRecord } from './types';
import {
  resolveExecutionReportAgentId,
  resolveExecutionReportConversationIdForUpload,
} from '../../../shared/reporting/execution-report-agent-id';

/** Backend POST body for `/management/claw/report/execution` (camelCase). */
export interface ExecutionUploadPayload {
  executionId: string;
  conversationId: string;
  turnIndex?: number;
  workNo: string;
  entrySource: ExecutionRecord['entry_source'];
  agentType: ExecutionRecord['agent_type'];
  agentId: string;
  modelId: string;
  status: ExecutionRecord['status'];
  startedAt?: string;
  endedAt?: string;
  firstResponseMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  createBy?: string;
  createDate?: string;
  updateBy?: string;
  updateDate?: string;
  errorStage?: ExecutionRecord['error_stage'];
  errorMessage?: string;
  appVersion?: string;
}

export function toExecutionUploadPayload(
  record: ExecutionRecord,
  agentIdLookup?: ReadonlyMap<string, string>,
): ExecutionUploadPayload {
  const runtimeAgentId = record.agent_id;
  const reportAgentId = resolveExecutionReportAgentId(
    runtimeAgentId,
    record.agent_type,
    agentIdLookup,
  );
  const payload: ExecutionUploadPayload = {
    executionId: record.execution_id,
    conversationId: resolveExecutionReportConversationIdForUpload(
      record.conversation_id,
      record.entry_source,
      runtimeAgentId,
      reportAgentId,
    ),
    workNo: record.work_no,
    entrySource: record.entry_source,
    agentType: record.agent_type,
    agentId: reportAgentId,
    modelId: record.model_id,
    status: record.status,
  };

  if (typeof record.turn_index === 'number' && record.turn_index > 0) {
    payload.turnIndex = record.turn_index;
  }
  if (record.started_at) payload.startedAt = record.started_at;
  if (record.ended_at) payload.endedAt = record.ended_at;
  if (typeof record.first_response_ms === 'number') {
    payload.firstResponseMs = record.first_response_ms;
  }
  if (typeof record.input_tokens === 'number') payload.inputTokens = record.input_tokens;
  if (typeof record.output_tokens === 'number') payload.outputTokens = record.output_tokens;
  if (typeof record.cache_read_tokens === 'number') {
    payload.cacheReadTokens = record.cache_read_tokens;
  }
  if (record.create_by) payload.createBy = record.create_by;
  if (record.create_date) payload.createDate = record.create_date;
  if (record.update_by) payload.updateBy = record.update_by;
  if (record.update_date) payload.updateDate = record.update_date;
  if (record.error_stage) payload.errorStage = record.error_stage;
  if (record.error_message) payload.errorMessage = record.error_message;
  if (record.app_version) payload.appVersion = record.app_version;

  return payload;
}

export function toExecutionUploadPayloads(
  records: ExecutionRecord[],
  agentIdLookup?: ReadonlyMap<string, string>,
): ExecutionUploadPayload[] {
  return records.map((record) => toExecutionUploadPayload(record, agentIdLookup));
}
