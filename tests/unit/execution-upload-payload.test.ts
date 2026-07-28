import { describe, expect, it } from 'vitest';
import { toExecutionUploadPayload } from '@electron/utils/reporting/execution-upload-payload';
import type { ExecutionRecord } from '@electron/utils/reporting/types';

describe('toExecutionUploadPayload', () => {
  it('maps internal snake_case execution records to backend camelCase', () => {
    const record: ExecutionRecord = {
      execution_id: 'exec-1',
      conversation_id: 'agent:main:session-1',
      turn_index: 2,
      work_no: '11427193',
      entry_source: 'chat',
      agent_type: 'normal',
      agent_id: 'main',
      model_id: 'auto',
      status: 'success',
      started_at: '2026-07-27 16:00:00',
      ended_at: '2026-07-27 16:00:05',
      first_response_ms: 1200,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 10,
      create_by: '11427193',
      create_date: '2026-07-27 15:59:00',
      update_by: '11427193',
      update_date: '2026-07-27 16:00:05',
      error_message: '',
      app_version: '1.2.3',
    };

    expect(toExecutionUploadPayload(record)).toEqual({
      executionId: 'exec-1',
      conversationId: 'agent:main:session-1',
      turnIndex: 2,
      workNo: '11427193',
      entrySource: 'chat',
      agentType: 'normal',
      agentId: 'main',
      modelId: 'auto',
      status: 'success',
      startedAt: '2026-07-27 16:00:00',
      endedAt: '2026-07-27 16:00:05',
      firstResponseMs: 1200,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      createBy: '11427193',
      createDate: '2026-07-27 15:59:00',
      updateBy: '11427193',
      updateDate: '2026-07-27 16:00:05',
      appVersion: '1.2.3',
    });
  });

  it('omits optional fields when absent', () => {
    expect(toExecutionUploadPayload({
      execution_id: 'exec-2',
      conversation_id: 'agent:main:session-2',
      work_no: '11427193',
      entry_source: 'chat',
      agent_type: 'normal',
      agent_id: 'main',
      model_id: 'auto',
      status: 'failed',
      error_stage: 'gateway',
      error_message: 'timeout',
    })).toEqual({
      executionId: 'exec-2',
      conversationId: 'agent:main:session-2',
      workNo: '11427193',
      entrySource: 'chat',
      agentType: 'normal',
      agentId: 'main',
      modelId: 'auto',
      status: 'failed',
      errorStage: 'gateway',
      errorMessage: 'timeout',
    });
  });
});
