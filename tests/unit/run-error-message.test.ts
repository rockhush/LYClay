import { describe, expect, it } from 'vitest';
import {
  isRecoverableRuntimeError,
  truncateRunErrorMessage,
} from '@/stores/chat/helpers';

describe('run error message helpers', () => {
  it('truncates oversized runtime errors', () => {
    const long = 'x'.repeat(600);
    expect(truncateRunErrorMessage(long)).toHaveLength(481);
    expect(truncateRunErrorMessage(long).endsWith('…')).toBe(true);
  });

  it('detects recoverable gateway errors', () => {
    expect(isRecoverableRuntimeError('Connection terminated unexpectedly')).toBe(true);
    expect(isRecoverableRuntimeError('Tool execution failed: invalid path')).toBe(false);
  });
});
