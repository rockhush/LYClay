/**
 * Resolve and persist DingTalk jobNumber (workNo) for usage reporting.
 *
 * Records are often queued before OAuth finishes hydrating jobNumber, or while
 * transcript scans run with an empty store read. We cache the last known workNo
 * after login/startup and backfill empty queue rows at flush time.
 */

import { logger } from '../logger';
import { getSetting, setSetting } from '../store';
import type { AppSettings } from '../store';
import { enrichDingTalkUserProfile, type DingTalkUserInfo } from '../dingtalk-oauth';
import type {
  SkillDownloadRecord,
  SkillInvokeRecord,
  TokenConsumeRecord,
  UsageReportQueueSnapshot,
} from './types';

function normalizeWorkNo(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function userStoreToDingTalkUserInfo(
  user: NonNullable<AppSettings['dingtalkUser']>,
): DingTalkUserInfo {
  return {
    unionId: user.unionId,
    name: user.name,
    avatar: user.avatar,
    mobile: user.mobile,
    email: user.email,
    orgEmail: user.orgEmail,
    jobNumber: user.jobNumber,
    title: user.title,
    workPlace: user.workPlace,
    userId: user.userId,
    nickname: user.nickname,
    admin: user.admin,
    boss: user.boss,
    senior: user.senior,
    active: user.active,
    disableStatus: user.disableStatus,
    hideMobile: user.hideMobile,
    realAuthed: user.realAuthed,
    createTime: user.createTime,
    hiredDate: user.hiredDate,
    loginId: user.loginId,
    managerUserId: user.managerUserId,
    exclusiveAccount: user.exclusiveAccount,
    exclusiveAccountType: user.exclusiveAccountType,
    exclusiveAccountCorpId: user.exclusiveAccountCorpId,
    exclusiveAccountCorpName: user.exclusiveAccountCorpName,
    deptIdList: user.deptIdList,
    roleList: user.roleList,
    leaderInDept: user.leaderInDept,
  };
}

function resolveWorkNoFromUser(user: NonNullable<AppSettings['dingtalkUser']> | null | undefined): string {
  if (!user) return '';
  return normalizeWorkNo(user.jobNumber) || normalizeWorkNo(user.userId);
}

export async function getCachedWorkNo(): Promise<string> {
  const cached = await getSetting('usageReportCachedWorkNo');
  return normalizeWorkNo(cached);
}

export async function cacheWorkNo(workNo: string): Promise<void> {
  const normalized = normalizeWorkNo(workNo);
  if (!normalized) return;
  const existing = await getCachedWorkNo();
  if (existing === normalized) return;
  await setSetting('usageReportCachedWorkNo', normalized);
}

export async function clearCachedWorkNo(): Promise<void> {
  await setSetting('usageReportCachedWorkNo', null);
}

/**
 * When DWS login leaves jobNumber empty, pull it from the DingTalk profile API
 * and persist back to electron-store before usage reporting runs.
 */
export async function ensureWorkNoReady(): Promise<string> {
  const user = await getSetting('dingtalkUser');
  if (user && !normalizeWorkNo(user.jobNumber) && normalizeWorkNo(user.userId)) {
    try {
      const enriched = await enrichDingTalkUserProfile(userStoreToDingTalkUserInfo(user));
      const nextJobNumber = normalizeWorkNo(enriched.jobNumber);
      if (nextJobNumber && nextJobNumber !== user.jobNumber) {
        await setSetting('dingtalkUser', { ...user, jobNumber: nextJobNumber });
        logger.info(`[UsageReport] Enriched DingTalk jobNumber for ${user.userId}`);
      }
    } catch (error) {
      logger.warn('[UsageReport] Failed to enrich DingTalk jobNumber:', error);
    }
  }

  const refreshedUser = await getSetting('dingtalkUser');
  const resolved = resolveWorkNoFromUser(refreshedUser) || await getCachedWorkNo();
  if (resolved) {
    await cacheWorkNo(resolved);
  }
  return resolved;
}

/**
 * Read jobNumber from the live DingTalk session and persist it when present.
 * Safe to call on every app launch.
 */
export async function hydrateWorkNoCacheFromStore(): Promise<string> {
  return ensureWorkNoReady();
}

/**
 * Resolve workNo for new queue records: prefer live DingTalk jobNumber, then
 * userId, then the cached value from a previous successful login.
 */
export async function resolveWorkNo(): Promise<string> {
  const user = await getSetting('dingtalkUser');
  const live = resolveWorkNoFromUser(user);
  if (live) {
    await cacheWorkNo(live);
    return live;
  }
  return await getCachedWorkNo();
}

export function applyWorkNoToQueueSnapshot(
  snapshot: UsageReportQueueSnapshot,
  workNo: string,
): UsageReportQueueSnapshot {
  const normalized = normalizeWorkNo(workNo);
  if (!normalized) return snapshot;

  const fill = <T extends { workNo: string }>(records: T[]): T[] => (
    records.map((record) => (
      normalizeWorkNo(record.workNo) ? record : { ...record, workNo: normalized }
    ))
  );

  return {
    tokenConsume: fill(snapshot.tokenConsume),
    skillDownload: fill(snapshot.skillDownload),
    skillInvoke: fill(snapshot.skillInvoke),
  };
}
