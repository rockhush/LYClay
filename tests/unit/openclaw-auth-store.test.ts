// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testHomes: string[] = [];

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    homedir: () => testHomes[testHomes.length - 1] ?? actual.homedir(),
  };
});

async function setupHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'lyclaw-auth-store-'));
  testHomes.push(home);
  return home;
}

describe('openclaw-auth-store', () => {
  beforeEach(() => {
    testHomes.length = 0;
  });

  afterEach(async () => {
    while (testHomes.length > 0) {
      const home = testHomes.pop();
      if (home) {
        await rm(home, { recursive: true, force: true });
      }
    }
    vi.resetModules();
  });

  it('migrates legacy auth-profiles.json into SQLite and round-trips credentials', async () => {
    const home = await setupHome();
    const agentDir = join(home, '.openclaw', 'agents', 'main', 'agent');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'auth-profiles.json'), JSON.stringify({
      version: 1,
      profiles: {
        'custom-custom16:default': {
          type: 'api_key',
          provider: 'custom-custom16',
          key: 'sk-test-key',
        },
      },
      order: {
        'custom-custom16': ['custom-custom16:default'],
      },
      lastGood: {
        'custom-custom16': 'custom-custom16:default',
      },
    }, null, 2), 'utf8');

    const storeModule = await import('../../electron/utils/openclaw-auth-store');
    const migrated = await storeModule.migrateAgentAuthStoreToSqlite('main');
    expect(migrated).toBe(true);

    const loaded = await storeModule.loadAgentAuthProfileStore('main');
    expect(loaded.profiles['custom-custom16:default']).toEqual({
      type: 'api_key',
      provider: 'custom-custom16',
      key: 'sk-test-key',
    });
    expect(loaded.order?.['custom-custom16']).toEqual(['custom-custom16:default']);

    await storeModule.saveAgentAuthProfileStore('main', {
      ...loaded,
      profiles: {
        ...loaded.profiles,
        'custom-custom99:default': {
          type: 'api_key',
          provider: 'custom-custom99',
          key: 'sk-new',
        },
      },
      order: {
        ...loaded.order,
        'custom-custom99': ['custom-custom99:default'],
      },
      lastGood: {
        ...loaded.lastGood,
        'custom-custom99': 'custom-custom99:default',
      },
    });

    const reloaded = await storeModule.loadAgentAuthProfileStore('main');
    expect(reloaded.profiles['custom-custom99:default']?.type).toBe('api_key');
    expect(reloaded.profiles['custom-custom16:default']?.type).toBe('api_key');
  });
});
