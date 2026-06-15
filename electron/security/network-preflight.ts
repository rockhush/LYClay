import { assertNetworkAllowedWithConfirmation } from './confirmation-service';

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`，。！？、；：]+/gi;
const TRAILING_PUNCTUATION = /[),.;!?，。！？、；：]+$/;

export function extractHttpUrls(text: string): string[] {
  const urls = new Set<string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, '');
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        urls.add(parsed.toString());
      }
    } catch {
      // Ignore malformed URL-looking text; network-policy validates actual URLs.
    }
  }
  return [...urls];
}

export async function assertTextNetworkAllowed(text: string, source: string): Promise<void> {
  const urls = extractHttpUrls(text);
  for (const url of urls) {
    // URLs explicitly included in a user chat request are treated as public
    // information reads. Local/private targets and suspicious URLs still go
    // through network-policy and may be blocked or require confirmation.
    await assertNetworkAllowedWithConfirmation({
      url,
      source,
      intent: 'public-read',
      method: 'GET',
    });
  }
}

export async function assertGatewayRpcNetworkAllowed(method: string, params: unknown): Promise<void> {
  if (method !== 'chat.send') return;
  if (!params || typeof params !== 'object') return;
  const message = (params as Record<string, unknown>).message;
  if (typeof message !== 'string' || !message.trim()) return;
  await assertTextNetworkAllowed(message, 'gateway:rpc:chat.send');
}
