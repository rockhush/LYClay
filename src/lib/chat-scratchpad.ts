/** True when the user is on a fresh thread with no persisted history metadata yet. */
export function isEmptyChatScratchpad(
  sessionKey: string | undefined | null,
  snapshot: {
    messages: unknown[];
    sessionLabels: Record<string, string>;
    sessionLastActivity: Record<string, number>;
  },
): boolean {
  const key = sessionKey?.trim();
  if (!key) return false;
  return snapshot.messages.length === 0
    && !snapshot.sessionLabels[key]
    && !snapshot.sessionLastActivity[key];
}
