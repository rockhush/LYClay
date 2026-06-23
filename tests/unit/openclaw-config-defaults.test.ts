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
  it('sets maxConcurrent=8 when agents.defaults is missing', () => {
    const config: Record<string, unknown> = {};
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({ defaults: { maxConcurrent: 8 } });
  });

  it('preserves existing agents.defaults while adding maxConcurrent', () => {
    const config: Record<string, unknown> = { agents: { defaults: { thinkingDefault: 'off' } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents).toEqual({ defaults: { thinkingDefault: 'off', maxConcurrent: 8 } });
  });

  it('returns false when maxConcurrent is already 8', () => {
    const config: Record<string, unknown> = { agents: { defaults: { maxConcurrent: 8 } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(false);
  });

  it('overrides a non-default value to the product default', () => {
    const config: Record<string, unknown> = { agents: { defaults: { maxConcurrent: 4 } } };
    expect(ensureOpenClawAgentDefaults(config)).toBe(true);
    expect(config.agents.defaults).toEqual({ maxConcurrent: 8 });
  });
});
