const SILENT_REPLY_TOKENS = /\b(?:NO_REPLY|HEARTBEAT_OK)\b/i;

/** Strip OpenClaw silent reply tokens from assistant-visible text. */
export function stripSilentReplyToken(text: string): string {
  if (!text) return text;
  const trimmed = text.trim();
  if (/^(HEARTBEAT_OK|NO_REPLY)\s*$/i.test(trimmed)) return '';
  if (/^\s*(?:NO_REPLY|HEARTBEAT_OK)\b/i.test(trimmed)) return '';
  return text.replace(/(?:\r?\n|\r|\s)*\b(?:NO_REPLY|HEARTBEAT_OK)\b\s*$/i, '').trimEnd();
}

export function containsSilentReplyToken(text: string): boolean {
  return SILENT_REPLY_TOKENS.test(text);
}

function stripTextContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return stripSilentReplyToken(content);
  }
  if (!Array.isArray(content)) return content;

  let touched = false;
  const next = content.map((block) => {
    if (!block || typeof block !== 'object') return block;
    const record = block as { type?: unknown; text?: unknown };
    if (typeof record.text !== 'string') return block;
    const stripped = stripSilentReplyToken(record.text);
    if (stripped === record.text) return block;
    touched = true;
    return { ...record, text: stripped };
  });

  return touched ? next : content;
}

/** Sanitize a transcript/history message object before UI display or API return. */
export function sanitizeTranscriptMessageForDisplay(message: unknown): unknown {
  if (!message || typeof message !== 'object') return message;
  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== 'assistant') return message;

  const content = stripTextContent(record.content);
  if (content === record.content) return message;
  return { ...record, content };
}
