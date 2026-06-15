import { describe, expect, it } from 'vitest';
import {
  inspectRedacted,
  redactSecrets,
  redactStructuredSecrets,
  redactUnknown,
  scanSecrets,
} from '@electron/security/secret-scanner';

const bearer = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
const githubToken = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
const awsAccessKey = 'AKIAIOSFODNN7EXAMPLE';
const providerToken = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';
const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

describe('secret scanner and redactor', () => {
  it('detects common credential shapes without exposing them in excerpts', () => {
    const text = [
      `Authorization: ${bearer}`,
      `OPENAI_API_KEY=${providerToken}`,
      `github=${githubToken}`,
      `aws=${awsAccessKey}`,
      `jwt=${jwt}`,
      'url=https://user:pass@example.com/path',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'abc123secretmaterial',
      '-----END OPENSSH PRIVATE KEY-----',
    ].join('\n');

    const findings = scanSecrets(text);

    expect(findings.map((finding) => finding.type)).toEqual(expect.arrayContaining([
      'bearer-token',
      'openai-token',
      'github-token',
      'aws-access-key',
      'jwt',
      'url-credentials',
      'ssh-private-key',
    ]));
    expect(findings.map((finding) => finding.excerpt).join('\n')).not.toContain(providerToken);
    expect(findings.map((finding) => finding.excerpt).join('\n')).not.toContain(githubToken);
  });

  it('redacts strings while preserving useful surrounding context', () => {
    const text = `fetch https://user:pass@example.com/path?api_key=${providerToken} with ${bearer}`;
    const redacted = redactSecrets(text);

    expect(redacted).toContain('https://[REDACTED]@example.com/path?api_key=[REDACTED]');
    expect(redacted).toContain('Bearer [REDACTED]');
    expect(redacted).not.toContain('user:pass');
    expect(redacted).not.toContain(providerToken);
    expect(redacted).not.toContain(bearer);
  });

  it('redacts nested object fields and secret-like strings', () => {
    const redacted = redactUnknown({
      headers: {
        Authorization: bearer,
      },
      apiKey: providerToken,
      nested: {
        message: `token=${githubToken}`,
      },
      list: [`password=${awsAccessKey}`],
    });

    expect(redacted).toEqual({
      headers: {
        Authorization: '[REDACTED]',
      },
      apiKey: '[REDACTED]',
      nested: {
        message: 'token=[REDACTED]',
      },
      list: ['password=[REDACTED]'],
    });
  });

  it('provides a redacted inspect helper for log payloads', () => {
    const inspected = inspectRedacted({
      url: `https://user:pass@example.com/?api_key=${providerToken}`,
      token: githubToken,
    });

    expect(inspected).toContain('[REDACTED]');
    expect(inspected).not.toContain(providerToken);
    expect(inspected).not.toContain(githubToken);
    expect(inspected).not.toContain('user:pass');
  });

  it('redacts structured transcript secrets while preserving numeric token usage', () => {
    const redacted = redactStructuredSecrets({
      content: `Authorization: ${bearer}`,
      toolResult: {
        token: 'short-sensitive-value',
        totalTokens: 42,
      },
    });

    expect(redacted).toEqual({
      content: 'Authorization: Bearer [REDACTED]',
      toolResult: {
        token: '[REDACTED]',
        totalTokens: 42,
      },
    });
  });
});
