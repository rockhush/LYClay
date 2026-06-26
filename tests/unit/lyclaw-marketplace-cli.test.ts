import { describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../scripts/lyclaw-marketplace-args.mjs';

describe('lyclaw-marketplace-cli', () => {
  it('parses search flags', () => {
    expect(parseCliArgs(['search', '--query', '报销', '--sort', '-update_time'])).toEqual({
      command: 'search',
      positional: [],
      options: {
        query: '报销',
        category: '',
        sort: '-update_time',
        version: undefined,
        name: undefined,
      },
    });
  });

  it('parses install positional id', () => {
    expect(parseCliArgs(['install', '123', '--name', 'Demo Skill'])).toEqual({
      command: 'install',
      positional: ['123'],
      options: {
        query: '',
        category: '',
        sort: '-download_count',
        version: undefined,
        name: 'Demo Skill',
      },
    });
  });

  it('returns help command', () => {
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
  });
});
