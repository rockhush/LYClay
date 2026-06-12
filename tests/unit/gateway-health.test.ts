import { describe, expect, it } from 'vitest';
import { buildGatewayHealthSummary } from '@electron/utils/gateway-health';

describe('buildGatewayHealthSummary', () => {
  it('marks recent stuck session diagnostics in gateway health summary', () => {
    const summary = buildGatewayHealthSummary({
      status: {
        state: 'running',
        port: 18789,
      },
      diagnostics: {
        consecutiveHeartbeatMisses: 0,
        consecutiveRpcFailures: 0,
        lastStuckSessionAt: Date.now(),
        lastStuckSession: {
          sessionId: 'main',
          sessionKey: 'agent:main:session-123',
          state: 'processing',
          ageSeconds: 140,
          queueDepth: 1,
          raw: 'stuck session: sessionId=main sessionKey=agent:main:session-123 state=processing age=140s queueDepth=1',
        },
      },
      platform: process.platform,
    });

    expect(summary.state).toBe('degraded');
    expect(summary.reasons).toContain('chat_session_stuck');
    expect(summary.lastStuckSession?.sessionKey).toBe('agent:main:session-123');
  });
});
