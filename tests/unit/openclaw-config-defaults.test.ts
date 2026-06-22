import { describe, expect, it } from 'vitest';
import { ensureOpenClawAgentDefaults, ensureOpenClawSessionDefaults } from '@electron/utils/openclaw-config-defaults';

describe('ensureOpenClawSessionDefaults', () => {
  it('adds the default dmScope when session is missing', () => {
    const config: Record<string, unknown> = {};

    expect(ensureOpenClawSessionDefaults(config)).toBe(true);
    expect(config.session).toEqual({ dmScope: 'per-account-channel-peer' });
  });

  it('preserves existing session settings while adding dmScope', () => {
    const config: Record<string, unknown> = { session: { idleMinutes: 10080 } };

    expect(ensureOpenClawSessionDefaults(config)).toBe(true);
    expect(config.session).toEqual({ idleMinutes: 10080, dmScope: 'per-account-channel-peer' });
  });

  it('preserves explicit valid dmScope values', () => {
    for (const dmScope of ['main', 'per-peer', 'per-channel-peer', 'per-account-channel-peer']) {
      const config: Record<string, unknown> = { session: { dmScope } };

      expect(ensureOpenClawSessionDefaults(config)).toBe(false);
      expect(config.session).toEqual({ dmScope });
    }
  });

  it('replaces invalid dmScope values with the product default', () => {
    const config: Record<string, unknown> = { session: { dmScope: 'per-channel' } };

    expect(ensureOpenClawSessionDefaults(config)).toBe(true);
    expect(config.session).toEqual({ dmScope: 'per-account-channel-peer' });
  });

  it('replaces non-object session values with an object containing the default', () => {
    for (const session of [null, 'main', ['main']]) {
      const config: Record<string, unknown> = { session };

      expect(ensureOpenClawSessionDefaults(config)).toBe(true);
      expect(config.session).toEqual({ dmScope: 'per-account-channel-peer' });
    }
  });
});

describe('ensureOpenClawAgentDefaults', () => {
  it('sets agent and compaction defaults when agents.defaults is missing', () => {
    const config: Record<string, unknown> = {};
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({
      defaults: {
        maxConcurrent: 8,
        contextTokens: 128000,
        contextLimits: {
          toolResultMaxChars: 8000,
        },
        compaction: {
          mode: 'safeguard',
          notifyUser: true,
          reserveTokens: 32768,
          reserveTokensFloor: 32768,
          keepRecentTokens: 16000,
          truncateAfterCompaction: true,
          maxActiveTranscriptBytes: '8mb',
          midTurnPrecheck: { enabled: true },
        },
      },
    });
  });

  it('preserves existing agents.defaults while adding LYClaw defaults', () => {
    const config: Record<string, unknown> = { agents: { defaults: { thinkingDefault: 'off' } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({
      defaults: {
        thinkingDefault: 'off',
        maxConcurrent: 8,
        contextTokens: 128000,
        contextLimits: {
          toolResultMaxChars: 8000,
        },
        compaction: {
          mode: 'safeguard',
          notifyUser: true,
          reserveTokens: 32768,
          reserveTokensFloor: 32768,
          keepRecentTokens: 16000,
          truncateAfterCompaction: true,
          maxActiveTranscriptBytes: '8mb',
          midTurnPrecheck: { enabled: true },
        },
      },
    });
  });

  it('returns false when LYClaw agent defaults already match', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 8,
          contextTokens: 128000,
          contextLimits: {
            toolResultMaxChars: 8000,
          },
          compaction: {
            mode: 'safeguard',
            notifyUser: true,
            reserveTokens: 32768,
            reserveTokensFloor: 32768,
            keepRecentTokens: 16000,
            truncateAfterCompaction: true,
            maxActiveTranscriptBytes: '8mb',
            midTurnPrecheck: { enabled: true },
          },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(false);
  });

  it('overrides non-default LYClaw values to the product defaults', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 4,
          contextTokens: 200000,
          contextLimits: {
            toolResultMaxChars: 32000,
            memoryGetMaxChars: 64000,
          },
          compaction: {
            mode: 'default',
            notifyUser: false,
            reserveTokens: 10000,
            reserveTokensFloor: 10000,
            midTurnPrecheck: { enabled: false, other: 'kept' },
            keepRecentTokens: 20000,
            truncateAfterCompaction: false,
            maxActiveTranscriptBytes: '64mb',
          },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents.defaults).toEqual({
      maxConcurrent: 8,
      contextTokens: 128000,
      contextLimits: {
        toolResultMaxChars: 8000,
        memoryGetMaxChars: 64000,
      },
      compaction: {
        mode: 'safeguard',
        notifyUser: true,
        reserveTokens: 32768,
        reserveTokensFloor: 32768,
        midTurnPrecheck: { enabled: true, other: 'kept' },
        keepRecentTokens: 16000,
        truncateAfterCompaction: true,
        maxActiveTranscriptBytes: '8mb',
      },
    });
  });
});
