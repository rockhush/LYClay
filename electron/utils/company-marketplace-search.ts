export type MarketplaceSearchSkill = {
  name: string;
  description?: string;
  author?: string;
};

/** Whitespace and common Chinese/ASCII list separators */
const TOKEN_SPLIT_RE = /[\s,，、；;/|+|]+/;

/** Short continuous CJK queries use 2-char AND tokens; longer phrases stay as one substring */
const CJK_BIGRAM_MAX_LEN = 8;

function isCjkChar(char: string): boolean {
  return /[\u4e00-\u9fff]/.test(char);
}

function isCjkText(value: string): boolean {
  return value.length > 0 && [...value].every(isCjkChar);
}

function chunkCjkByTwoChars(text: string): string[] {
  const tokens: string[] = [];
  for (let index = 0; index < text.length; index += 2) {
    const chunk = text.slice(index, index + 2);
    if (chunk.length === 2) {
      tokens.push(chunk);
    } else if (tokens.length > 0) {
      tokens[tokens.length - 1] += chunk;
    } else {
      tokens.push(chunk);
    }
  }
  return tokens.filter((token) => token.length > 0);
}

/**
 * Split mixed Latin/digit/CJK runs: `excel报销` -> [`excel`, `报销`].
 */
function splitMixedScriptSegment(segment: string): string[] {
  const parts: string[] = [];
  let buffer = '';
  let lastIsCjk: boolean | null = null;

  for (const char of segment) {
    const isCjk = isCjkChar(char);
    if (lastIsCjk !== null && isCjk !== lastIsCjk && buffer) {
      parts.push(buffer);
      buffer = '';
    }
    buffer += char;
    lastIsCjk = isCjk;
  }

  if (buffer) {
    parts.push(buffer);
  }

  return parts;
}

function expandSegment(segment: string): string[] {
  const normalized = segment.toLowerCase();
  if (!normalized) {
    return [];
  }

  const scriptParts = splitMixedScriptSegment(normalized);
  const tokens: string[] = [];

  for (const part of scriptParts) {
    if (isCjkText(part)) {
      if (part.length <= 2) {
        tokens.push(part);
      } else if (part.length <= CJK_BIGRAM_MAX_LEN) {
        tokens.push(...chunkCjkByTwoChars(part));
      } else {
        // Long natural-language CJK: keep whole phrase as one substring token.
        tokens.push(part);
      }
      continue;
    }

    tokens.push(part);
  }

  return tokens;
}

/**
 * Marketplace query tokenization (all tokens must match — AND semantics):
 *
 * 1. Split on whitespace / punctuation first: `报销 excel` -> [`报销`, `excel`]
 * 2. Split mixed scripts per segment: `excel报销` -> [`excel`, `报销`]
 * 3. Short pure CJK (3–8 chars) into 2-char chunks: `考勤助手` -> [`考勤`, `助手`]
 * 4. Long pure CJK (>8) stays one token: full substring match only
 */
export function tokenizeMarketplaceQuery(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const segments = normalized.split(TOKEN_SPLIT_RE).filter(Boolean);
  const parts = segments.length > 0 ? segments : [normalized];

  return parts.flatMap(expandSegment).filter(Boolean);
}

function skillHaystack(skill: MarketplaceSearchSkill): string {
  return [skill.name, skill.description ?? '', skill.author ?? '']
    .join(' ')
    .toLowerCase();
}

export function matchesMarketplaceQuery(skill: MarketplaceSearchSkill, query: string): boolean {
  const tokens = tokenizeMarketplaceQuery(query);
  if (tokens.length === 0) {
    return true;
  }

  const haystack = skillHaystack(skill);
  return tokens.every((token) => haystack.includes(token));
}
