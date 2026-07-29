import { describe, expect, it } from 'vitest';
import {
  inferMarketEmployeeAgentIdFromInstanceId,
  resolveExecutionReportAgentId,
  resolveExecutionReportConversationId,
  resolveExecutionReportConversationIdForUpload,
  resolveScheduleReportConversationId,
} from '../../shared/reporting/execution-report-agent-id';

describe('execution report agent id mapping', () => {
  it('infers market agent id from runtime digital employee instance id', () => {
    expect(
      inferMarketEmployeeAgentIdFromInstanceId('employee-recruitment-specialist-8f6b71f4'),
    ).toBe('employee-recruitment-specialist');
    expect(inferMarketEmployeeAgentIdFromInstanceId('employee-recruitment-specialist')).toBeNull();
    expect(inferMarketEmployeeAgentIdFromInstanceId('employee-recruitment')).toBeNull();
    expect(inferMarketEmployeeAgentIdFromInstanceId('main')).toBeNull();
  });

  it('prefers installed lookup over slug inference', () => {
    const lookup = new Map([
      ['employee-recruitment-specialist-8f6b71f4', '7'],
    ]);
    expect(resolveExecutionReportAgentId(
      'employee-recruitment-specialist-8f6b71f4',
      'digital_employee',
      lookup,
    )).toBe('7');
  });

  it('falls back to slug inference for digital employee records', () => {
    expect(resolveExecutionReportAgentId(
      'employee-recruitment-specialist-8f6b71f4',
      'digital_employee',
    )).toBe('employee-recruitment-specialist');
  });

  it('leaves normal agent ids unchanged', () => {
    expect(resolveExecutionReportAgentId('main', 'normal')).toBe('main');
    expect(resolveExecutionReportAgentId('research', 'normal')).toBe('research');
  });

  it('rewrites conversationId prefix when report agent id differs', () => {
    expect(resolveExecutionReportConversationId(
      'agent:employee-recruitment-specialist-8f6b71f4:session-1785225532250',
      'employee-recruitment-specialist-8f6b71f4',
      'employee-recruitment-specialist',
    )).toBe('agent:employee-recruitment-specialist:session-1785225532250');
    expect(resolveExecutionReportConversationId(
      'agent:main:session-1',
      'main',
      'main',
    )).toBe('agent:main:session-1');
  });

  it('shortens scheduled-task session keys to per-run id for upload', () => {
    const sessionKey = 'agent:main:scheduled-task:46f41448-0d2f-49bd-a6a2-e1245576a17d:ada7e5ab-de77-42b2-9272-c027e18dcf92';
    expect(resolveScheduleReportConversationId(sessionKey))
      .toBe('ada7e5ab-de77-42b2-9272-c027e18dcf92');
    expect(resolveExecutionReportConversationIdForUpload(
      sessionKey,
      'schedule',
      'main',
      'main',
    )).toBe('ada7e5ab-de77-42b2-9272-c027e18dcf92');
  });
});
