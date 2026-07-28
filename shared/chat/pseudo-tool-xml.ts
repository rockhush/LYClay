const PSEUDO_TOOL_BLOCK_PATTERN = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g;
const PSEUDO_TOOL_PARAM_PATTERN = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g;

/** Tool names OpenClaw models sometimes emit as XML text instead of structured tool_use blocks. */
const PSEUDO_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'exec',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
]);

function normalizePseudoToolName(name: string): string {
  return name.trim().toLowerCase();
}

function isPseudoToolName(name: string): boolean {
  return PSEUDO_TOOL_NAMES.has(normalizePseudoToolName(name));
}

function parsePseudoToolInput(inner: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const match of inner.matchAll(PSEUDO_TOOL_PARAM_PATTERN)) {
    const key = (match[1] || '').trim();
    const value = (match[2] || '').trim();
    if (key) input[key] = value;
  }
  return input;
}

export function extractPseudoToolCallsFromText(
  text: string,
): Array<{ name: string; input: Record<string, unknown> }> {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  const tools: Array<{ name: string; input: Record<string, unknown> }> = [];
  for (const match of trimmed.matchAll(PSEUDO_TOOL_BLOCK_PATTERN)) {
    const name = normalizePseudoToolName(match[1] || '');
    if (!isPseudoToolName(name)) continue;
    tools.push({ name, input: parsePseudoToolInput(match[2] || '') });
  }
  return tools;
}

export function stripPseudoToolXmlFromText(text: string): string {
  const stripped = (text || '').replace(PSEUDO_TOOL_BLOCK_PATTERN, (full, rawName: string) => (
    isPseudoToolName(rawName) ? '' : full
  ));
  // Preserve newlines so markdown headers/lists/tables still render after stripping.
  return stripped.trim();
}

export function isPseudoToolOnlyText(text: string): boolean {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  return extractPseudoToolCallsFromText(trimmed).length > 0
    && stripPseudoToolXmlFromText(trimmed).length === 0;
}
