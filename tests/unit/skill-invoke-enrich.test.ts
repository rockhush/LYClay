import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillInvokeRecord } from '@electron/utils/reporting/types';

const listLocalDigitalEmployees = vi.hoisted(() => vi.fn(async () => [] as Array<{
  agentId: string;
  name: string;
}>));

vi.mock('@electron/utils/digital-employee-storage', () => ({
  listLocalDigitalEmployees,
}));

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async () => undefined),
}));

import { enrichSkillInvokeRecordsForUpload } from '@electron/utils/reporting/skill-invoke-enrich';

describe('enrichSkillInvokeRecordsForUpload', () => {
  beforeEach(() => {
    listLocalDigitalEmployees.mockReset();
    listLocalDigitalEmployees.mockResolvedValue([]);
  });

  it('maps digital employee agent_id to display name and skill_source', async () => {
    listLocalDigitalEmployees.mockResolvedValue([{
      agentId: 'dqe-quality-specialist-0206ab31',
      name: 'DQE质量流程数字员工',
    }]);

    const record: SkillInvokeRecord = {
      workNo: '11427193',
      skillId: 'dqe-sip-create',
      count: 1,
      invokeTime: '2026-07-27 16:00:00',
      create_by: '11427193',
      create_date: '2026-07-27 15:59:00',
      update_by: '11427193',
      update_date: '2026-07-27 16:00:00',
      execution_id: 'exec-1',
      agent_id: 'dqe-quality-specialist-0206ab31',
      skill_source: 'local',
      invoke_mode: 'model_selected',
      invoke_time: '2026-07-27 16:00:00',
      invoke_end_time: '2026-07-27 16:00:05',
      status: 'success',
    };

    const enriched = await enrichSkillInvokeRecordsForUpload([record], []);
    expect(enriched).toHaveLength(1);
    expect(enriched[0]?.agent_id).toBe('DQE质量流程数字员工');
    expect(enriched[0]?.skill_source).toBe('digital_employee');
  });
});
