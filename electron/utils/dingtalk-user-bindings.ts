import { getSetting, setSetting, type AppSettings } from './store';

export const OFFICIAL_DINGTALK_ACCOUNT_ID = 'lyclaw-official';
const DEFAULT_AGENT_ID = 'main';

export interface DingTalkUserBinding {
  dingUserId: string;
  unionId: string;
  officialAccountId: string;
  personalAccountIds: string[];
  defaultAccountId: string;
  agentId: string;
  sessionKey: string;
  createdAt: string;
  updatedAt: string;
}

export type DingTalkUserBindings = Record<string, DingTalkUserBinding>;

export interface DingTalkUserBindingInput {
  dingUserId: string;
  unionId?: string;
  officialAccountId?: string;
  personalAccountIds?: string[];
  defaultAccountId?: string;
  agentId?: string;
  sessionKey?: string;
}

function normalizeUserId(userId: string): string {
  return userId.trim();
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

export function buildDingTalkSingleChatSessionKey(
  accountId: string,
  userId: string,
  corpId?: string,
): string {
  const account = accountId.trim() || OFFICIAL_DINGTALK_ACCOUNT_ID;
  const user = normalizeUserId(userId);
  const corp = corpId?.trim();
  return corp ? `dingtalk:${account}:single:${corp}:${user}` : `dingtalk:${account}:single:${user}`;
}

export function buildDingTalkBindingId(userId: string, accountId = OFFICIAL_DINGTALK_ACCOUNT_ID): string {
  return `dingtalk:${normalizeUserId(userId)}:${accountId.trim() || OFFICIAL_DINGTALK_ACCOUNT_ID}`;
}

export async function listDingTalkUserBindings(): Promise<DingTalkUserBindings> {
  return await getSetting('dingtalkUserBindings') ?? {};
}

export async function getDingTalkUserBinding(userId: string): Promise<DingTalkUserBinding | null> {
  const normalizedUserId = normalizeUserId(userId);
  if (!normalizedUserId) return null;
  const bindings = await listDingTalkUserBindings();
  return bindings[normalizedUserId] ?? null;
}

export async function upsertDingTalkUserBinding(input: DingTalkUserBindingInput): Promise<DingTalkUserBinding> {
  const dingUserId = normalizeUserId(input.dingUserId);
  if (!dingUserId) {
    throw new Error('dingUserId is required');
  }

  const bindings = await listDingTalkUserBindings();
  const existing = bindings[dingUserId];
  const now = new Date().toISOString();
  const officialAccountId = input.officialAccountId?.trim()
    || existing?.officialAccountId
    || OFFICIAL_DINGTALK_ACCOUNT_ID;
  const personalAccountIds = uniqueNonEmpty([
    ...(existing?.personalAccountIds ?? []),
    ...(input.personalAccountIds ?? []),
  ]).filter((accountId) => accountId !== officialAccountId);
  const defaultAccountId = input.defaultAccountId?.trim()
    || existing?.defaultAccountId
    || officialAccountId;
  const agentId = input.agentId?.trim()
    || existing?.agentId
    || DEFAULT_AGENT_ID;

  const binding: DingTalkUserBinding = {
    dingUserId,
    unionId: input.unionId?.trim() ?? existing?.unionId ?? '',
    officialAccountId,
    personalAccountIds,
    defaultAccountId,
    agentId,
    sessionKey: input.sessionKey?.trim()
      || existing?.sessionKey
      || buildDingTalkSingleChatSessionKey(officialAccountId, dingUserId),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  await setSetting('dingtalkUserBindings', {
    ...bindings,
    [dingUserId]: binding,
  } as AppSettings['dingtalkUserBindings']);

  return binding;
}
