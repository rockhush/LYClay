import { enrichDingTalkUserProfile } from './dingtalk-oauth';
import { getSetting } from './store';
import type { AppSettings } from './store';

export interface LogIdentityContext {
  workNo: string;
  userName: string;
  identityMissingReason: 'missing_dingtalk_user' | 'missing_work_no' | 'missing_user_name' | null;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveWorkNo(user: NonNullable<AppSettings['dingtalkUser']>): string {
  return normalizeText(user.jobNumber) || normalizeText(user.userId);
}

export async function resolveLogIdentityContext(): Promise<LogIdentityContext> {
  const storedUser = await getSetting('dingtalkUser');
  if (!storedUser) {
    return {
      workNo: '',
      userName: '',
      identityMissingReason: 'missing_dingtalk_user',
    };
  }

  const enrichedUser = await enrichDingTalkUserProfile(storedUser);
  const workNo = resolveWorkNo(enrichedUser as NonNullable<AppSettings['dingtalkUser']>);
  const userName = normalizeText(enrichedUser.name);

  let identityMissingReason: LogIdentityContext['identityMissingReason'] = null;
  if (!workNo) {
    identityMissingReason = 'missing_work_no';
  } else if (!userName) {
    identityMissingReason = 'missing_user_name';
  }

  return {
    workNo,
    userName,
    identityMissingReason,
  };
}
