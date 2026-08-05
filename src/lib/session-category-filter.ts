import { isCronSessionKey } from '@/stores/chat/cron-session-utils';

export type SidebarSessionCategoryFilter = 'all' | 'cron' | 'session';

/** User-created chat sessions use `agent:<agentId>:session-<timestamp>`. */
export function isNormalChatSessionKey(sessionKey: string): boolean {
  if (!sessionKey.startsWith('agent:')) return false;
  const suffix = sessionKey.split(':').slice(2).join(':');
  return suffix.startsWith('session-');
}

export function matchesSidebarSessionCategoryFilter(
  sessionKey: string,
  filter: SidebarSessionCategoryFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'cron') return isCronSessionKey(sessionKey);
  if (filter === 'session') return isNormalChatSessionKey(sessionKey);
  return true;
}
