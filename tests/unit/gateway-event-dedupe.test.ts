import { describe, expect, it } from 'vitest';
import { shouldProcessGatewayEvent } from '@/stores/gateway';

describe('gateway event dedupe', () => {
  it('keeps processing delta events without seq for the same run', () => {
    const first = shouldProcessGatewayEvent({
      state: 'delta',
      runId: 'run-no-seq',
      sessionKey: 'agent:main:main',
      message: { role: 'assistant', content: 'first chunk' },
    });

    const second = shouldProcessGatewayEvent({
      state: 'delta',
      runId: 'run-no-seq',
      sessionKey: 'agent:main:main',
      message: { role: 'assistant', content: 'second chunk' },
    });

    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it('still dedupes repeated delta events when seq matches', () => {
    const first = shouldProcessGatewayEvent({
      state: 'delta',
      runId: 'run-with-seq',
      sessionKey: 'agent:main:main',
      seq: 3,
      message: { role: 'assistant', content: 'first version' },
    });

    const second = shouldProcessGatewayEvent({
      state: 'delta',
      runId: 'run-with-seq',
      sessionKey: 'agent:main:main',
      seq: 3,
      message: { role: 'assistant', content: 'duplicate version' },
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});
