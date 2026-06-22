/**
 * Token Estimation Utilities
 * Rough estimation for context window management.
 * Note: This is an approximation, actual tokenization depends on the model.
 */

/**
 * Estimate tokens for a text string.
 * - Chinese/CJK characters: ~1 token each (conservative for context guards)
 * - ASCII/Latin characters: ~0.5 tokens each
 * - Whitespace: ~0.25 tokens each
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let count = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    // Chinese/CJK range
    if (code >= 0x4e00 && code <= 0x9fff) {
      count += 1;
    } else if (/\s/.test(char)) {
      count += 0.25;
    } else {
      count += 0.5;
    }
  }
  return Math.ceil(count);
}

/**
 * Estimate tokens for a RawMessage content.
 */
export function estimateMessageTokens(content: unknown): number {
  if (!content) return 0;

  if (typeof content === 'string') {
    return estimateTokens(content);
  }

  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateMessageTokens(block), 0);
  }

  if (typeof content === 'object') {
    const block = content as Record<string, unknown>;
    // Handle content blocks with different shapes
    if (block.text) {
      return estimateTokens(String(block.text));
    }
    if (block.thinking) {
      return estimateTokens(String(block.thinking));
    }
    if (block.input) {
      return estimateTokens(JSON.stringify(block.input));
    }
    if (block.arguments) {
      return estimateTokens(String(block.arguments));
    }
    if (block.content) {
      return estimateMessageTokens(block.content);
    }
    // Fallback: serialize the object
    return estimateTokens(JSON.stringify(content));
  }

  return estimateTokens(String(content));
}

/**
 * Estimate total tokens for a message array.
 */
export function estimateHistoryTokens(messages: Array<{ role: string; content: unknown }>): number {
  return messages.reduce((sum, msg) => {
    const contentTokens = estimateMessageTokens(msg.content);
    // Add overhead for role markers (~4 tokens per message)
    return sum + contentTokens + 4;
  }, 0);
}

/**
 * Check if history exceeds threshold and needs compression.
 */
export function needsCompression(
  messages: Array<{ role: string; content: unknown }>,
  threshold: number,
): boolean {
  return estimateHistoryTokens(messages) >= threshold;
}
