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
  const FULL_COMPACTION_DEFAULTS = {
    mode: 'default',
    notifyUser: true,
    reserveTokensFloor: 32000,
    keepRecentTokens: 20000,
    timeoutSeconds: 900,
    midTurnPrecheck: { enabled: false },
    truncateAfterCompaction: false,
    memoryFlush: { enabled: true, softThresholdTokens: 12000, forceFlushTranscriptBytes: '2mb' },
  };

  it('sets maxConcurrent=30 and full compaction defaults when agents.defaults is missing', () => {
    const config: Record<string, unknown> = {};
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({
      defaults: { maxConcurrent: 30, compaction: FULL_COMPACTION_DEFAULTS },
    });
  });

  it('preserves existing agents.defaults while adding maxConcurrent and compaction defaults', () => {
    const config: Record<string, unknown> = { agents: { defaults: { thinkingDefault: 'off' } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({
      defaults: {
        thinkingDefault: 'off',
        maxConcurrent: 30,
        compaction: FULL_COMPACTION_DEFAULTS,
      },
    });
  });

  it('returns false when maxConcurrent=30 and compaction is already fully populated with safe defaults', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          compaction: { ...FULL_COMPACTION_DEFAULTS },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(false);
  });

  it('overrides a non-default maxConcurrent and fills compaction defaults', () => {
    const config: Record<string, unknown> = { agents: { defaults: { maxConcurrent: 4 } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect((config.agents as { defaults: Record<string, unknown> }).defaults).toEqual({
      maxConcurrent: 30,
      compaction: FULL_COMPACTION_DEFAULTS,
    });
  });

  it('sets ly-auto agent contextTokens to the 200K default', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          model: { primary: 'ly-auto/auto', fallbacks: [] },
          compaction: { ...FULL_COMPACTION_DEFAULTS },
        },
      },
    };

    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
    expect(defaults.contextTokens).toBe(200000);
  });

  it('migrates legacy 128K ly-auto agent contextTokens to the 200K default', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          model: { primary: 'ly-auto/auto', fallbacks: [] },
          contextTokens: 128000,
          compaction: { ...FULL_COMPACTION_DEFAULTS },
        },
      },
    };

    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
    expect(defaults.contextTokens).toBe(200000);
  });

  it('removes managed contextTokens when the default model is not ly-auto', () => {
    for (const contextTokens of [128000, 200000]) {
      const config: Record<string, unknown> = {
        agents: {
          defaults: {
            maxConcurrent: 30,
            model: { primary: 'custom-customb2/deepseek-v4-pro', fallbacks: [] },
            contextTokens,
            compaction: { ...FULL_COMPACTION_DEFAULTS },
          },
        },
      };

      expect(ensureOpenClawAgentDefaults(config)).toBe(true);
      const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
      expect(defaults.contextTokens).toBeUndefined();
    }
  });

  it('preserves custom positive agent contextTokens', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          model: { primary: 'custom-customb2/deepseek-v4-pro', fallbacks: [] },
          contextTokens: 1048576,
          compaction: { ...FULL_COMPACTION_DEFAULTS },
        },
      },
    };

    expect(ensureOpenClawAgentDefaults(config)).toBe(false);
    const defaults = (config.agents as { defaults: Record<string, unknown> }).defaults;
    expect(defaults.contextTokens).toBe(1048576);
  });

  it('forces midTurnPrecheck.enabled=false when legacy config has it enabled', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          contextTokens: 200000,
          compaction: { ...FULL_COMPACTION_DEFAULTS, midTurnPrecheck: { enabled: true } },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction.midTurnPrecheck).toEqual({ enabled: false });
  });

  it('migrates legacy 128K compaction defaults to the 200K-safe defaults', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          contextTokens: 200000,
          compaction: {
            mode: 'default',
            notifyUser: true,
            reserveTokensFloor: 8192,
            keepRecentTokens: 40000,
            timeoutSeconds: 900,
            midTurnPrecheck: { enabled: false },
            truncateAfterCompaction: false,
            memoryFlush: { enabled: true, softThresholdTokens: 8000 },
          },
        },
      },
    };

    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction).toEqual(FULL_COMPACTION_DEFAULTS);
  });

  it('migrates previous browser-heavy compaction defaults to tighter defaults', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          contextTokens: 200000,
          compaction: {
            mode: 'default',
            notifyUser: true,
            reserveTokensFloor: 32000,
            keepRecentTokens: 50000,
            timeoutSeconds: 900,
            midTurnPrecheck: { enabled: false },
            truncateAfterCompaction: false,
            memoryFlush: { enabled: true, softThresholdTokens: 24000, forceFlushTranscriptBytes: '8mb' },
          },
        },
      },
    };

    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction).toEqual(FULL_COMPACTION_DEFAULTS);
  });
  it('preserves custom positive compaction budgets while filling missing memory flush fields', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          contextTokens: 200000,
          compaction: {
            mode: 'default',
            notifyUser: true,
            reserveTokensFloor: 48000,
            keepRecentTokens: 60000,
            timeoutSeconds: 1200,
            midTurnPrecheck: { enabled: false },
            truncateAfterCompaction: false,
            memoryFlush: { enabled: true, softThresholdTokens: 30000 },
          },
        },
      },
    };

    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction).toMatchObject({
      reserveTokensFloor: 48000,
      keepRecentTokens: 60000,
      timeoutSeconds: 1200,
      memoryFlush: {
        enabled: true,
        softThresholdTokens: 30000,
        forceFlushTranscriptBytes: '2mb',
      },
    });
  });

  it('rewrites non-default compaction.mode back to "default"', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          contextTokens: 200000,
          compaction: { ...FULL_COMPACTION_DEFAULTS, mode: 'safeguard' },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction.mode).toBe('default');
  });

  it('forces truncateAfterCompaction=false when legacy config has it enabled', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 30,
          contextTokens: 200000,
          compaction: { ...FULL_COMPACTION_DEFAULTS, truncateAfterCompaction: true },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction.truncateAfterCompaction).toBe(false);
  });
});
