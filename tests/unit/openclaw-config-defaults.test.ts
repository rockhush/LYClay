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
    reserveTokensFloor: 8192,
    keepRecentTokens: 40000,
    timeoutSeconds: 900,
    midTurnPrecheck: { enabled: false },
    truncateAfterCompaction: false,
    memoryFlush: { enabled: true, softThresholdTokens: 8000 },
  };

  it('sets maxConcurrent=8 and full compaction defaults when agents.defaults is missing', () => {
    const config: Record<string, unknown> = {};
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({
      defaults: { maxConcurrent: 8, compaction: FULL_COMPACTION_DEFAULTS },
    });
  });

  it('preserves existing agents.defaults while adding maxConcurrent and compaction defaults', () => {
    const config: Record<string, unknown> = { agents: { defaults: { thinkingDefault: 'off' } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({
      defaults: { thinkingDefault: 'off', maxConcurrent: 8, compaction: FULL_COMPACTION_DEFAULTS },
    });
  });

  it('returns false when maxConcurrent=8 and compaction is already fully populated with safe defaults', () => {
    const config: Record<string, unknown> = {
      agents: { defaults: { maxConcurrent: 8, compaction: { ...FULL_COMPACTION_DEFAULTS } } },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(false);
  });

  it('overrides a non-default maxConcurrent and fills compaction defaults', () => {
    const config: Record<string, unknown> = { agents: { defaults: { maxConcurrent: 4 } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect((config.agents as { defaults: Record<string, unknown> }).defaults).toEqual({
      maxConcurrent: 8,
      compaction: FULL_COMPACTION_DEFAULTS,
    });
  });

  it('forces midTurnPrecheck.enabled=false when legacy config has it enabled', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 8,
          compaction: { ...FULL_COMPACTION_DEFAULTS, midTurnPrecheck: { enabled: true } },
        },
      },
    };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    const compaction = (config.agents as { defaults: { compaction: Record<string, unknown> } })
      .defaults.compaction;
    expect(compaction.midTurnPrecheck).toEqual({ enabled: false });
  });

  it('rewrites non-default compaction.mode back to "default"', () => {
    const config: Record<string, unknown> = {
      agents: {
        defaults: {
          maxConcurrent: 8,
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
          maxConcurrent: 8,
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
