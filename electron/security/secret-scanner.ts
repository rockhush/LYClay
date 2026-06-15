import util from 'node:util';

export type SecretFindingType =
  | 'api-key-assignment'
  | 'aws-access-key'
  | 'bearer-token'
  | 'github-token'
  | 'jwt'
  | 'openai-token'
  | 'ssh-private-key'
  | 'url-credentials';

export interface SecretFinding {
  type: SecretFindingType;
  ruleId: string;
  risk: 'medium' | 'high' | 'critical';
  start: number;
  end: number;
  excerpt: string;
}

interface SecretRule {
  id: string;
  type: SecretFindingType;
  risk: SecretFinding['risk'];
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

interface SecretMatch extends SecretFinding {
  replacement: string;
}

const REDACTED = '[REDACTED]';
const MAX_SCAN_TEXT_LENGTH = 1024 * 1024;

const sensitiveObjectKeyPattern =
  /token|password|secret|api[_-]?key|authorization|credential|access[_-]?key|client[_-]?secret|private[_-]?key/i;

const secretRules: SecretRule[] = [
  {
    id: 'ssh-private-key-block',
    type: 'ssh-private-key',
    risk: 'critical',
    pattern: /-----BEGIN (?:(?:OPENSSH|RSA|DSA|EC|ENCRYPTED) )?PRIVATE KEY-----[\s\S]*?-----END (?:(?:OPENSSH|RSA|DSA|EC|ENCRYPTED) )?PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    id: 'url-credentials',
    type: 'url-credentials',
    risk: 'high',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
    replacement: (_match, protocol: string) => `${protocol}${REDACTED}@`,
  },
  {
    id: 'bearer-token',
    type: 'bearer-token',
    risk: 'high',
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi,
    replacement: 'Bearer [REDACTED]',
  },
  {
    id: 'github-token',
    type: 'github-token',
    risk: 'high',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    id: 'aws-access-key',
    type: 'aws-access-key',
    risk: 'high',
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    replacement: REDACTED,
  },
  {
    id: 'jwt',
    type: 'jwt',
    risk: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: REDACTED,
  },
  {
    id: 'openai-or-provider-token',
    type: 'openai-token',
    risk: 'high',
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9][A-Za-z0-9_-]{16,}\b/g,
    replacement: REDACTED,
  },
  {
    id: 'api-key-assignment',
    type: 'api-key-assignment',
    risk: 'medium',
    pattern: /\b(api[_-]?key|token|password|secret|access[_-]?key|client[_-]?secret)\s*([:=])\s*([^\s"',;}&]+)/gi,
    replacement: (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`,
  },
];

function scanInput(text: string): string {
  return text.length > MAX_SCAN_TEXT_LENGTH ? text.slice(0, MAX_SCAN_TEXT_LENGTH) : text;
}

function makeExcerpt(text: string, start: number, end: number): string {
  const prefix = text.slice(Math.max(0, start - 24), start);
  const suffix = text.slice(end, Math.min(text.length, end + 24));
  return `${prefix}${REDACTED}${suffix}`;
}

function replacementForRule(rule: SecretRule, match: RegExpExecArray): string {
  if (typeof rule.replacement === 'string') return rule.replacement;
  return rule.replacement(match[0], ...match.slice(1));
}

function collectMatches(text: string): SecretMatch[] {
  const input = scanInput(text);
  const matches: SecretMatch[] = [];

  for (const rule of secretRules) {
    rule.pattern.lastIndex = 0;
    for (let match = rule.pattern.exec(input); match != null; match = rule.pattern.exec(input)) {
      if (!match[0]) continue;
      matches.push({
        type: rule.type,
        ruleId: rule.id,
        risk: rule.risk,
        start: match.index,
        end: match.index + match[0].length,
        excerpt: makeExcerpt(input, match.index, match.index + match[0].length),
        replacement: replacementForRule(rule, match),
      });
    }
  }

  return matches
    .sort((a, b) => a.start - b.start || b.end - a.end)
    .filter((match, index, sorted) => index === 0 || match.start >= sorted[index - 1].end);
}

export function scanSecrets(text: string): SecretFinding[] {
  return collectMatches(text).map(({ replacement: _replacement, ...finding }) => finding);
}

export function redactSecrets(text: string): string {
  const matches = collectMatches(text);
  if (matches.length === 0) return text;

  let out = '';
  let cursor = 0;
  for (const match of matches) {
    out += text.slice(cursor, match.start);
    out += match.replacement;
    cursor = match.end;
  }
  out += text.slice(cursor);
  return out;
}

export function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = sensitiveObjectKeyPattern.test(key) ? REDACTED : redactUnknown(nested);
  }
  return out;
}

/**
 * Redact structured user-facing content without replacing useful numeric
 * metadata such as token usage counters.
 */
export function redactStructuredSecrets(value: unknown): unknown {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactStructuredSecrets);
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (sensitiveObjectKeyPattern.test(key) && typeof nested === 'string') {
      out[key] = REDACTED;
      continue;
    }
    out[key] = redactStructuredSecrets(nested);
  }
  return out;
}

export function inspectRedacted(value: unknown): string {
  return redactSecrets(util.inspect(redactUnknown(value), { depth: 8, breakLength: 120 }));
}
