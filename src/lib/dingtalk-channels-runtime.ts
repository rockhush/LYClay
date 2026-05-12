import { toOpenClawChannelType } from '@/lib/channel-alias';
import {
  isChannelRuntimeConnected,
  pickChannelRuntimeStatus,
  type ChannelRuntimeAccountSnapshot,
  type ChannelRuntimeSummarySnapshot,
} from '@/lib/channel-status';

/** Minimal `channels.status` RPC payload shape for dingtalk readiness. */
export type ChannelsStatusRpcPayload = {
  channels?: Record<string, { configured?: boolean; error?: string; lastError?: string }>;
  channelAccounts?: Record<string, ChannelRuntimeAccountSnapshot[]>;
  channelDefaultAccountId?: Record<string, string>;
};

/**
 * True when OpenClaw reports dingtalk configured and the default (or any) account looks connected.
 * Used to keep the post-login warmup screen up until Stream/runtime is healthy when env auto-provision is on.
 */
export function isOpenClawDingTalkChannelRuntimeReady(data: ChannelsStatusRpcPayload | null | undefined): boolean {
  if (!data?.channels) return false;
  const gatewayId = toOpenClawChannelType('dingtalk');
  const summary = data.channels[gatewayId] as ChannelRuntimeSummarySnapshot | undefined;
  const accounts = data.channelAccounts?.[gatewayId] ?? [];
  const configured =
    typeof summary === 'object' && summary && typeof summary.configured === 'boolean'
      ? summary.configured
      : accounts.length > 0;
  if (!configured) return false;
  const status = pickChannelRuntimeStatus(accounts, summary);
  if (status === 'connected') return true;
  return accounts.some((a) => isChannelRuntimeConnected(a));
}
