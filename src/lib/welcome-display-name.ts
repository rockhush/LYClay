/**
 * Format DingTalk / profile name for the chat welcome greeting.
 * Drops English prefixes like "Ken/" and shows a short Chinese given name:
 * - 2 chars → both (张三)
 * - 3+ chars → last 2 chars (袁益千 → 益千)
 */
export function formatWelcomeDisplayName(raw: string | null | undefined): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';

  const segment = trimmed.includes('/')
    ? trimmed.split('/').pop()?.trim() ?? trimmed
    : trimmed;

  const chineseChars = segment.match(/[\u4e00-\u9fff]/gu);
  if (!chineseChars?.length) {
    return segment;
  }

  const chineseName = chineseChars.join('');
  if (chineseName.length <= 2) {
    return chineseName;
  }
  return chineseName.slice(-2);
}
