import { describe, expect, it } from 'vitest';
import {
  clearStaleInAppDeliveryErrorState,
  isStaleInAppDeliveryError,
  isUiInAppCronJob,
} from '@electron/gateway/cron-stale-errors';

describe('cron stale in-app delivery errors', () => {
  it('detects stale delivery errors from broken external sends', () => {
    expect(isStaleInAppDeliveryError('Message failed')).toBe(true);
    expect(isStaleInAppDeliveryError('delivery failed: no recipient')).toBe(true);
    expect(isStaleInAppDeliveryError('Channel is required')).toBe(true);
    expect(isStaleInAppDeliveryError('DingTalk message requires --to <conversationId>')).toBe(true);
    expect(isStaleInAppDeliveryError('agent turn failed: timeout')).toBe(false);
  });

  it('clears stale errors only for in-app isolated agentTurn jobs', () => {
    const inAppJob = {
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
      delivery: { mode: 'none' },
      state: { lastStatus: 'error', lastError: 'Message failed' },
    };
    expect(isUiInAppCronJob(inAppJob)).toBe(true);
    expect(clearStaleInAppDeliveryErrorState(inAppJob)).toBe(true);
    expect(inAppJob.state.lastStatus).toBe('ok');
    expect(inAppJob.state.lastError).toBeUndefined();

    const externalJob = {
      sessionTarget: 'isolated',
      payload: { kind: 'agentTurn' },
      delivery: { mode: 'announce', channel: 'dingtalk', to: 'cid' },
      state: { lastStatus: 'error', lastError: 'Message failed' },
    };
    expect(clearStaleInAppDeliveryErrorState(externalJob)).toBe(false);
    expect(externalJob.state.lastError).toBe('Message failed');
  });
});
