import { beforeEach, describe, expect, it, vi } from 'vitest';

const trackerState = vi.hoisted(() => ({
  executionId: 'exec-1',
  agentId: 'main',
  sessionStartedAtMs: Date.parse('2026-07-27T09:00:00'),
  startedAtMs: Date.parse('2026-07-27T09:22:00'),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/lib/execution-turn-tracker', () => ({
  getActiveExecutionId: () => trackerState.executionId,
  getActiveExecutionAuditContext: () => ({
    executionId: trackerState.executionId,
    agentId: trackerState.agentId,
    sessionStartedAtMs: trackerState.sessionStartedAtMs,
    startedAtMs: trackerState.startedAtMs,
  }),
}));

vi.mock('@/stores/skills', () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [
        { id: 'pptx', slug: 'pptx', name: 'pptx', source: 'bundled' },
        { id: 'AOI外观AI分析', slug: 'AOI外观AI分析', name: 'AOI外观AI分析', source: 'local' },
        { id: 'dqe-sip-create', slug: 'dqe-sip-create', name: 'dqe-sip-create', source: 'local' },
      ],
    }),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: {
    getState: () => ({
      agents: [
        {
          id: 'dqe-quality-specialist-0206ab31',
          name: 'DQE质量流程数字员工',
          isDigitalEmployee: true,
        },
      ],
    }),
  },
}));

vi.mock('@/stores/digital-employees', () => ({
  useDigitalEmployeesStore: {
    getState: () => ({
      employees: [
        {
          agentId: 'dqe-quality-specialist-0206ab31',
          name: 'DQE质量流程数字员工',
        },
      ],
    }),
  },
}));

import { hostApiFetch } from '@/lib/host-api';
import { formatSkillInvokeDateTimeMs } from '@/lib/skill-invoke-report';
import {
  finalizeSkillInvokeReports,
  registerPendingUserSelectedSkills,
  ensureSkillInvokeTurnTracking,
  reportUsageFromToolResult,
  resetSkillInvokeTurnTracking,
} from '@/stores/chat/skill-invoke-usage';
import type { RawMessage } from '@/stores/chat/types';

const hostApiFetchMock = vi.mocked(hostApiFetch);

describe('skill-invoke-usage', () => {
  beforeEach(() => {
    hostApiFetchMock.mockClear();
    resetSkillInvokeTurnTracking();
    trackerState.executionId = 'exec-1';
    trackerState.agentId = 'main';
  });

  it('reports success when read SKILL.md is observed before finalize', () => {
    registerPendingUserSelectedSkills({
      executionId: 'exec-1',
      agentId: 'main',
      skillIds: ['pptx'],
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const readStartMs = Date.parse('2026-07-27T09:22:05');
    const toolResultMs = Date.parse('2026-07-27T09:22:06');
    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const assistant: RawMessage = {
      role: 'assistant',
      timestamp: readStartMs,
      content: [
        { type: 'tool_use', id: 'call-1', name: 'read', input: { path: '~/.openclaw/skills/pptx/SKILL.md' } },
      ],
    };
    const toolResult: RawMessage = {
      role: 'toolResult',
      timestamp: toolResultMs,
      toolCallId: 'call-1',
      content: 'skill body',
    };
    const get = () => ({
      messages: [assistant],
      streamingMessage: null,
      currentAgentId: 'main',
    }) as never;

    reportUsageFromToolResult(undefined, toolResult, 'run-1', get);
    finalizeSkillInvokeReports(
      get,
      'run-1',
      {
        role: 'assistant',
        timestamp: turnEndMs,
        content: 'done',
      },
      turnEndMs,
    );

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'pptx',
      execution_id: 'exec-1',
      agent_id: 'main',
      invoke_mode: 'user_selected',
      status: 'success',
      invoke_time: formatSkillInvokeDateTimeMs(readStartMs),
      invoke_end_time: formatSkillInvokeDateTimeMs(toolResultMs),
    });
  });

  it('reports success when read is emitted as XML text instead of tool_use', () => {
    registerPendingUserSelectedSkills({
      executionId: 'exec-1',
      agentId: 'main',
      skillIds: ['AOI外观AI分析'],
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const readStartMs = Date.parse('2026-07-27T09:22:05');
    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const assistant: RawMessage = {
      role: 'assistant',
      timestamp: readStartMs,
      content: [{
        type: 'text',
        text: '<read> <path>~/.openclaw/skills/AOI外观AI分析/SKILL.md</path> </read>',
      }],
    };
    const get = () => ({
      messages: [assistant],
      streamingMessage: null,
      currentAgentId: 'main',
    }) as never;

    finalizeSkillInvokeReports(get, 'run-1', {
      role: 'assistant',
      timestamp: turnEndMs,
      content: '技能说明',
    }, turnEndMs);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'AOI外观AI分析',
      execution_id: 'exec-1',
      invoke_mode: 'user_selected',
      status: 'success',
      invoke_end_time: formatSkillInvokeDateTimeMs(readStartMs),
    });
  });

  it('reports context-cached success when user selected skill never read SKILL.md', () => {
    registerPendingUserSelectedSkills({
      executionId: 'exec-1',
      agentId: 'main',
      skillIds: ['pptx'],
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const get = () => ({
      messages: [],
      streamingMessage: null,
      currentAgentId: 'main',
    }) as never;

    finalizeSkillInvokeReports(get, 'run-1', undefined, turnEndMs);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'pptx',
      execution_id: 'exec-1',
      invoke_mode: 'user_selected',
      status: 'success',
      error_message: '调用上下文',
      invoke_end_time: formatSkillInvokeDateTimeMs(turnEndMs),
    });
  });

  it('reports model_selected when model reads SKILL.md without user selection', () => {
    ensureSkillInvokeTurnTracking({
      executionId: 'exec-1',
      agentId: 'main',
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const readStartMs = Date.parse('2026-07-27T09:22:05');
    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const userMessage: RawMessage = {
      role: 'user',
      timestamp: trackerState.startedAtMs,
      content: '帮我生成一个关于世界杯的PPT',
    };
    const assistant: RawMessage = {
      role: 'assistant',
      timestamp: readStartMs,
      content: [
        { type: 'tool_use', id: 'call-auto-1', name: 'read', input: { path: '~/.openclaw/skills/pptx/SKILL.md' } },
      ],
    };
    const get = () => ({
      messages: [userMessage, assistant],
      streamingMessage: null,
      currentAgentId: 'main',
    }) as never;

    finalizeSkillInvokeReports(get, 'run-1', {
      role: 'assistant',
      timestamp: turnEndMs,
      content: 'PPT 已生成',
    }, turnEndMs);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'pptx',
      execution_id: 'exec-1',
      agent_id: 'main',
      invoke_mode: 'model_selected',
      status: 'success',
      invoke_time: formatSkillInvokeDateTimeMs(readStartMs),
      invoke_end_time: formatSkillInvokeDateTimeMs(turnEndMs),
    });
  });

  it('reports digital employee skill with display name and digital_employee source', () => {
    trackerState.executionId = 'exec-de-1';
    trackerState.agentId = 'dqe-quality-specialist-0206ab31';

    ensureSkillInvokeTurnTracking({
      executionId: 'exec-de-1',
      agentId: 'dqe-quality-specialist-0206ab31',
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const readStartMs = Date.parse('2026-07-27T09:22:05');
    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const skillPath = '~/.openclaw/digital-employees/dqe-quality-specialist-0206ab31/skills/dqe-sip-create/SKILL.md';
    const assistant: RawMessage = {
      role: 'assistant',
      timestamp: readStartMs,
      content: [
        { type: 'tool_use', id: 'call-de-1', name: 'read', input: { path: skillPath } },
      ],
    };
    const get = () => ({
      messages: [assistant],
      streamingMessage: null,
      currentAgentId: 'dqe-quality-specialist-0206ab31',
    }) as never;

    finalizeSkillInvokeReports(get, 'run-de-1', {
      role: 'assistant',
      timestamp: turnEndMs,
      content: 'SIP 制作完成',
    }, turnEndMs);

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'dqe-sip-create',
      agent_id: 'DQE质量流程数字员工',
      skill_source: 'digital_employee',
      invoke_mode: 'model_selected',
      status: 'success',
    });
  });

  it('reports failed when turn ends with error and skill was read', () => {
    registerPendingUserSelectedSkills({
      executionId: 'exec-1',
      agentId: 'main',
      skillIds: ['pptx'],
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const readStartMs = Date.parse('2026-07-27T09:22:05');
    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const assistant: RawMessage = {
      role: 'assistant',
      timestamp: readStartMs,
      content: [
        { type: 'tool_use', id: 'call-1', name: 'read', input: { path: '~/.openclaw/skills/pptx/SKILL.md' } },
      ],
    };
    const get = () => ({
      messages: [assistant],
      streamingMessage: null,
      currentAgentId: 'main',
    }) as never;

    finalizeSkillInvokeReports(
      get,
      'run-1',
      undefined,
      turnEndMs,
      { status: 'failed', errorMessage: 'Gateway timeout' },
    );

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'pptx',
      status: 'failed',
      error_message: 'Gateway timeout',
    });
  });

  it('reports cancelled for context-cached skill when user aborts turn', () => {
    registerPendingUserSelectedSkills({
      executionId: 'exec-1',
      agentId: 'main',
      skillIds: ['pptx'],
      sessionStartedAtMs: trackerState.sessionStartedAtMs,
      turnStartedAtMs: trackerState.startedAtMs,
    });

    const turnEndMs = Date.parse('2026-07-27T09:22:20');
    const get = () => ({
      messages: [],
      streamingMessage: null,
      currentAgentId: 'main',
    }) as never;

    finalizeSkillInvokeReports(
      get,
      'run-1',
      undefined,
      turnEndMs,
      { status: 'cancelled' },
    );

    expect(hostApiFetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(hostApiFetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      skillId: 'pptx',
      status: 'cancelled',
    });
    expect(body.error_message).toBeUndefined();
  });
});
