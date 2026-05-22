/**
 * Debounced Gateway restart/reload after channel config changes.
 * Shared by Host API routes and DingTalk auto-provision (avoid utils importing routes).
 */
import type { HostApiContext } from '../api/context';
import { OPENCLAW_WECHAT_CHANNEL_TYPE, toOpenClawChannelType } from './channel-alias';

// Plugin-based channels require a full Gateway process restart to properly
// initialize / tear-down plugin connections.  SIGUSR1 in-process reload is
// not sufficient for channel plugins (see restartGatewayForAgentDeletion).
const FORCE_RESTART_CHANNELS = new Set([
  'dingtalk', 'wecom', 'whatsapp', 'feishu', 'qqbot', OPENCLAW_WECHAT_CHANNEL_TYPE,
  'discord', 'telegram', 'signal', 'imessage', 'matrix', 'line', 'msteams', 'googlechat', 'mattermost',
]);

export function scheduleGatewayChannelSaveRefresh(
  ctx: HostApiContext,
  channelType: string,
  reason: string,
): void {
  const storedChannelType = toOpenClawChannelType(channelType);
  if (FORCE_RESTART_CHANNELS.has(storedChannelType)) {
    ctx.gatewayManager.debouncedRestart(150);
    void reason;
    return;
  }
  ctx.gatewayManager.debouncedReload(150);
  void reason;
}
