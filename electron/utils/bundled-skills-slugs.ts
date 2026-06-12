/**
 * Skill slugs shipped as openclaw bundled skills (not user-managed ~/.openclaw/skills).
 * Used for homedir migration cleanup and marketplace filtering alignment.
 */
export const BUNDLED_SKILL_SLUGS = new Set([
  'pdf',
  'docx',
  'docxt',
  'pptx',
  'xlsx',
  'summarize',
  'github',
  'gh-issues',
  'coding',
  'coding-agent',
  'taskflow',
  'skill-creator',
  'find-skills',
  'session-logs',
  'brave-web-search',
  'self-improving-agent',
  'healthcheck',
  'tavily-search',
  'dws',
  'lingyi-baishitong',
  'mineru-ocr',
]);

export const PREINSTALLED_MARKER_NAME = '.LYClaw-preinstalled.json';
