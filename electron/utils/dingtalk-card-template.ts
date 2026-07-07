/**
 * DingTalk AI card template binding for OpenClaw @soimy/dingtalk plugin.
 *
 * The plugin reads `DINGTALK_CARD_TEMPLATE_ID` from the Gateway process env.
 * LYClaw stores a unified template ID in openclaw.json (channel + accounts)
 * and mirrors it into Gateway env on every launch so all DingTalk robots share
 * the same AI card layout.
 */
import { getLyclawEnvVariable } from './dingtalk-oauth';
import type { OpenClawConfig } from './channel-config';

/** LYClaw default card template (override via LYCLAW_DINGTALK_CARD_TEMPLATE_ID). */
export const DEFAULT_DINGTALK_CARD_TEMPLATE_ID = '2d85103f-a91d-443e-9b03-23b8bf95f630.schema';

/** Previous LYClaw auto-provisioned defaults; migrate to DEFAULT on read/sanitize. */
export const LEGACY_DINGTALK_CARD_TEMPLATE_IDS = [
  '83e768dc-f1c2-4fc0-a439-6d0526ba9614.schema',
  'b6e31343-a90a-4a0a-9c1d-6a1bd18b12c2.schema',
  'a7bcfad4-11ab-49b4-ba55-6d85c4e85846.schema',
] as const;

/** @deprecated Use LEGACY_DINGTALK_CARD_TEMPLATE_IDS */
export const LEGACY_DINGTALK_CARD_TEMPLATE_ID = LEGACY_DINGTALK_CARD_TEMPLATE_IDS[0];

function readDingTalkAccounts(section: Record<string, unknown>): Record<string, Record<string, unknown>> | null {
  const accounts = section.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) {
    return null;
  }
  return accounts as Record<string, Record<string, unknown>>;
}

export function resolveConfiguredDingTalkCardTemplateId(): string {
  return getLyclawEnvVariable('LYCLAW_DINGTALK_CARD_TEMPLATE_ID').trim()
    || (process.env.DINGTALK_CARD_TEMPLATE_ID?.trim() ?? '')
    || DEFAULT_DINGTALK_CARD_TEMPLATE_ID;
}

function normalizeTemplateId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Upgrade the previous LYClaw default template id without touching custom templates. */
export function normalizeStoredDingTalkCardTemplateId(value: unknown): string | undefined {
  const normalized = normalizeTemplateId(value);
  if (!normalized) return undefined;
  if ((LEGACY_DINGTALK_CARD_TEMPLATE_IDS as readonly string[]).includes(normalized)) {
    return DEFAULT_DINGTALK_CARD_TEMPLATE_ID;
  }
  return normalized;
}

function assignCardTemplateIdIfMissing(target: Record<string, unknown>, templateId: string): void {
  if (target.cardTemplateId === undefined) {
    target.cardTemplateId = templateId;
    return;
  }
  const migrated = normalizeStoredDingTalkCardTemplateId(target.cardTemplateId);
  if (migrated && migrated !== target.cardTemplateId) {
    target.cardTemplateId = migrated;
  }
}

function resolveDefaultDingTalkAccount(
  section: Record<string, unknown>,
  accounts: Record<string, Record<string, unknown>> | null,
): Record<string, unknown> | undefined {
  const defaultAccountId = typeof section.defaultAccount === 'string' && section.defaultAccount.trim()
    ? section.defaultAccount.trim()
    : 'default';

  return accounts?.[defaultAccountId]
    ?? accounts?.default
    ?? (accounts ? Object.values(accounts)[0] : undefined);
}

/** Resolve the active unified card template ID for Gateway + config sanitize. */
export function resolveActiveDingTalkCardTemplateId(config?: OpenClawConfig | null): string {
  const lyclawOverride = getLyclawEnvVariable('LYCLAW_DINGTALK_CARD_TEMPLATE_ID').trim();
  if (lyclawOverride) {
    return normalizeStoredDingTalkCardTemplateId(lyclawOverride) ?? lyclawOverride;
  }

  const dingtalk = config?.channels?.dingtalk;
  if (dingtalk && typeof dingtalk === 'object') {
    const section = dingtalk as Record<string, unknown>;
    const accounts = readDingTalkAccounts(section);
    const defaultAccount = resolveDefaultDingTalkAccount(section, accounts);
    const fromConfig = normalizeStoredDingTalkCardTemplateId(defaultAccount?.cardTemplateId)
      ?? normalizeStoredDingTalkCardTemplateId(section.cardTemplateId);
    if (fromConfig) {
      return fromConfig;
    }
  }

  return normalizeStoredDingTalkCardTemplateId(resolveConfiguredDingTalkCardTemplateId())
    ?? resolveConfiguredDingTalkCardTemplateId();
}

function shouldSyncAccountCardTemplateId(account: Record<string, unknown>, unifiedTemplateId: string): boolean {
  if (account.cardTemplateId === undefined) {
    return true;
  }
  const normalized = normalizeStoredDingTalkCardTemplateId(account.cardTemplateId);
  if (!normalized) {
    return true;
  }
  if (normalized !== account.cardTemplateId) {
    return true;
  }
  return normalized !== unifiedTemplateId;
}

/** LYClaw default: hide AI card footer status line (model / effort / agent). */
export const HIDDEN_DINGTALK_CARD_STATUS_LINE = {
  model: false,
  effort: false,
  agent: false,
  taskTime: false,
  tokens: false,
  dapiUsage: false,
} as const;

function assignHiddenCardStatusLineIfMissing(target: Record<string, unknown>): void {
  if (target.cardStatusLine === undefined) {
    target.cardStatusLine = { ...HIDDEN_DINGTALK_CARD_STATUS_LINE };
  }
}

/** Apply LYClaw card defaults on dingtalk channel + account sections (mutates in place). */
export function applyDingTalkCardTemplateDefaults(section: Record<string, unknown>): void {
  if (section.messageType === undefined) {
    section.messageType = 'card';
  }

  assignHiddenCardStatusLineIfMissing(section);

  const configuredDefault = resolveConfiguredDingTalkCardTemplateId();
  assignCardTemplateIdIfMissing(section, configuredDefault);

  const unifiedTemplateId = normalizeStoredDingTalkCardTemplateId(section.cardTemplateId)
    ?? configuredDefault;
  section.cardTemplateId = unifiedTemplateId;

  const accounts = readDingTalkAccounts(section);
  if (!accounts) return;

  for (const account of Object.values(accounts)) {
    if (!account || typeof account !== 'object') continue;
    if (account.messageType === undefined) {
      account.messageType = 'card';
    }
    assignHiddenCardStatusLineIfMissing(account);
    if (shouldSyncAccountCardTemplateId(account, unifiedTemplateId)) {
      account.cardTemplateId = unifiedTemplateId;
      continue;
    }
    const normalized = normalizeStoredDingTalkCardTemplateId(account.cardTemplateId);
    if (normalized) {
      account.cardTemplateId = normalized;
    }
  }
}

/** Resolve Gateway env vars for DingTalk card template binding. */
export function resolveDingTalkCardTemplateGatewayEnv(config: OpenClawConfig): Record<string, string> {
  const dingtalk = config.channels?.dingtalk;
  if (!dingtalk || typeof dingtalk !== 'object') {
    return {};
  }

  return { DINGTALK_CARD_TEMPLATE_ID: resolveActiveDingTalkCardTemplateId(config) };
}
