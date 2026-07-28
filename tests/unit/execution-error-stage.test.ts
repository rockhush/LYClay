import { describe, expect, it } from 'vitest';
import { classifyExecutionErrorStage } from '@/lib/execution-error-stage';

describe('classifyExecutionErrorStage', () => {
  it('returns client for empty messages and user cancellation', () => {
    expect(classifyExecutionErrorStage('')).toBe('client');
    expect(classifyExecutionErrorStage(undefined)).toBe('client');
    expect(classifyExecutionErrorStage('network timeout', { cancelled: true })).toBe('client');
  });

  it('classifies model/provider failures', () => {
    expect(classifyExecutionErrorStage('Invalid API key')).toBe('model');
    expect(classifyExecutionErrorStage('Rate limit exceeded')).toBe('model');
  });

  it('classifies gateway/connectivity failures', () => {
    expect(classifyExecutionErrorStage('Gateway websocket disconnected')).toBe('gateway');
    expect(classifyExecutionErrorStage('connect ECONNREFUSED 127.0.0.1:18789')).toBe('gateway');
  });
});
