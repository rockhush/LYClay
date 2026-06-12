import { describe, expect, it } from 'vitest';
import { applySettingsMigrations } from '@electron/utils/store';

describe('applySettingsMigrations', () => {
  it('disables legacy telemetry once for existing installs', () => {
    const state: Record<string, unknown> = {
      telemetryEnabled: true,
    };
    const store = {
      get: (key: string) => state[key],
      set: (key: string, value: unknown) => {
        state[key] = value;
      },
    };

    applySettingsMigrations(store);
    expect(state.telemetryEnabled).toBe(false);
    expect(state._internalMigrations).toEqual({ telemetryOptOutV202606: true });

    state.telemetryEnabled = true;
    applySettingsMigrations(store);
    expect(state.telemetryEnabled).toBe(true);
  });
});
