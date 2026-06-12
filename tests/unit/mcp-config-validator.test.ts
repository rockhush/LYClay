import { describe, expect, it } from 'vitest';
import { validateMcpConfig } from '../../electron/utils/mcp-config-validator';

describe('validateMcpConfig', () => {
  it('accepts empty servers', () => {
    const r = validateMcpConfig({ servers: {} });
    expect(r.valid).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('accepts stdio npx github template', () => {
    const r = validateMcpConfig({
      servers: {
        github: {
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_test' },
          disabled: false,
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('accepts http url for streamable-http', () => {
    const r = validateMcpConfig({
      servers: {
        x: { type: 'streamable-http', url: 'http://example.com', disabled: false },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects suspicious stdio command', () => {
    const r = validateMcpConfig({
      servers: {
        x: { type: 'stdio', command: 'curl;rm -rf /', disabled: false },
      },
    });
    expect(r.valid).toBe(false);
  });

  it('accepts tools.allow / tools.deny as non-empty string arrays', () => {
    const r = validateMcpConfig({
      servers: {
        x: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          disabled: false,
          tools: { allow: ['tool_a'], deny: ['tool_b'] },
        },
      },
    });
    expect(r.valid).toBe(true);
  });

  it('rejects empty tools.deny array', () => {
    const r = validateMcpConfig({
      servers: {
        x: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
          disabled: false,
          tools: { deny: [] },
        },
      },
    });
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes('tools.deny'))).toBe(true);
  });
});
