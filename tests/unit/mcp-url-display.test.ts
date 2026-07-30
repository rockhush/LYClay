import { describe, expect, it } from 'vitest';
import { redactMcpUrlForDisplay } from '../../shared/mcp-url-display';

describe('redactMcpUrlForDisplay', () => {
  it('redacts every query value and removes fragments', () => {
    expect(redactMcpUrlForDisplay(
      'https://example.com/mcp/sse?token=secret&api_key=second-secret#private',
    )).toBe('https://example.com/mcp/sse?token=***&api_key=***');
  });

  it('leaves query-free URLs unchanged', () => {
    expect(redactMcpUrlForDisplay('https://example.com/mcp')).toBe('https://example.com/mcp');
  });
});
