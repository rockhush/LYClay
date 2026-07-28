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
      ],
    }),
  },
}));

import { hostApiFetch } from '@/lib/host-api';
import { formatSkillInvokeDateTimeMs } from '@/lib/skill-invoke-report';
import {
  finalizeSkillInvokeReports,
  registerPendingUserSelectedSkills,
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
      timestamp: Date.parse('2026-07-27T09:22:06'),
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
      invoke_end_time: formatSkillInvokeDateTimeMs(turnEndMs),
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
    });
  });

  it('reports failed when user selected skill never read SKILL.md', () => {
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
      status: 'failed',
      invoke_end_time: formatSkillInvokeDateTimeMs(turnEndMs),
    });
  });
});
