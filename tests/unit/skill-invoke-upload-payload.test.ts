import { describe, expect, it } from 'vitest';
import { toSkillInvokeUploadPayload } from '@electron/utils/reporting/skill-invoke-upload-payload';
import type { SkillInvokeRecord } from '@electron/utils/reporting/types';

describe('toSkillInvokeUploadPayload', () => {
  it('maps internal snake_case skill-invoke records to backend camelCase', () => {
    const record: SkillInvokeRecord = {
      workNo: '11427193',
      skillId: 'cn-translate',
      count: 1,
      invokeTime: '2026-07-27 16:00:00',
      create_by: '11427193',
      create_date: '2026-07-27 15:59:00',
      update_by: '11427193',
      update_date: '2026-07-27 16:00:00',
      execution_id: 'exec-1',
      agent_id: 'main',
      skill_source: 'local',
      invoke_mode: 'user_selected',
      invoke_time: '2026-07-27 16:00:00',
      status: 'unknown',
    };

    expect(toSkillInvokeUploadPayload(record)).toEqual({
      createBy: '11427193',
      createDate: '2026-07-27 15:59:00',
      updateBy: '11427193',
      updateDate: '2026-07-27 16:00:00',
      executionId: 'exec-1',
      workNo: '11427193',
      agentId: 'main',
      skillId: 'cn-translate',
      skillSource: 'local',
      invokeMode: 'user_selected',
      invokeTime: '2026-07-27 16:00:00',
      status: 'unknown',
    });
  });

  it('includes invokeEndTime and errorMessage when present', () => {
    expect(toSkillInvokeUploadPayload({
      workNo: '11427193',
      skillId: 'web-search',
      count: 1,
      invokeTime: '2026-07-27 16:01:00',
      create_by: '11427193',
      create_date: '2026-07-27 16:01:00',
      update_by: '11427193',
      update_date: '2026-07-27 16:01:05',
      execution_id: 'exec-2',
      agent_id: 'main',
      skill_source: 'marketplace',
      invoke_mode: 'model_selected',
      invoke_time: '2026-07-27 16:01:00',
      invoke_end_time: '2026-07-27 16:01:05',
      status: 'failed',
      error_message: 'timeout',
    })).toEqual({
      createBy: '11427193',
      createDate: '2026-07-27 16:01:00',
      updateBy: '11427193',
      updateDate: '2026-07-27 16:01:05',
      executionId: 'exec-2',
      workNo: '11427193',
      agentId: 'main',
      skillId: 'web-search',
      skillSource: 'marketplace',
      invokeMode: 'model_selected',
      invokeTime: '2026-07-27 16:01:00',
      invokeEndTime: '2026-07-27 16:01:05',
      status: 'failed',
      errorMessage: 'timeout',
    });
  });
});
