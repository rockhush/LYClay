import { createHash } from 'node:crypto';
import type { DigitalEmployeePackageManifest } from '../../shared/types/digital-employee';

export type GlobalSub2ApiSubject = {
  scope: 'global';
  userNo: string;
  source: 'dingtalk.jobNumber' | 'dingtalk.userId';
};

export type DigitalEmployeeSub2ApiSubject = {
  scope: 'digitalEmployee';
  userNo: string;
  source:
    | 'manifest.sub2api.userNo'
    | 'manifest.package.id.lastSegment'
    | 'manifest.package.id'
    | 'marketEmployeeId';
  marketEmployeeId: string;
  packageId: string;
  packageName: string;
  instanceId: string;
  agentId: string;
};

export type Sub2ApiSubject = GlobalSub2ApiSubject | DigitalEmployeeSub2ApiSubject;

export type DingTalkSub2ApiIdentity = {
  jobNumber?: string | null;
  userId?: string | null;
};

export type DigitalEmployeeSubjectContext = {
  manifest: DigitalEmployeePackageManifest;
  marketEmployeeId: string | number;
  instanceId: string;
  agentId: string;
};

const MAX_SUB2API_SUBJECT_LENGTH = 64;

function normalizeExplicitUserNo(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function sanitizeShortCode(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, '-');
}

function isUsableSubject(value: string): boolean {
  return /[A-Za-z0-9_]/.test(value) && value.length <= MAX_SUB2API_SUBJECT_LENGTH;
}

function lastNonEmptySegment(packageId: string): string | null {
  const segments = packageId.split('.').map((segment) => segment.trim()).filter(Boolean);
  return segments.at(-1) ?? null;
}

export function resolveGlobalSub2ApiSubject(
  dingtalkUser: DingTalkSub2ApiIdentity | null | undefined,
): GlobalSub2ApiSubject | null {
  const jobNumber = normalizeExplicitUserNo(dingtalkUser?.jobNumber);
  if (jobNumber) {
    return { scope: 'global', userNo: jobNumber, source: 'dingtalk.jobNumber' };
  }

  const userId = normalizeExplicitUserNo(dingtalkUser?.userId);
  if (userId) {
    return { scope: 'global', userNo: userId, source: 'dingtalk.userId' };
  }

  return null;
}

export function resolveDigitalEmployeeSub2ApiSubject(
  context: DigitalEmployeeSubjectContext,
): DigitalEmployeeSub2ApiSubject | null {
  const packageId = context.manifest.package.id.trim();
  const base = {
    scope: 'digitalEmployee' as const,
    marketEmployeeId: String(context.marketEmployeeId).trim(),
    packageId,
    packageName: context.manifest.package.name,
    instanceId: context.instanceId,
    agentId: context.agentId,
  };

  const explicitUserNo = normalizeExplicitUserNo(context.manifest.sub2api?.userNo);
  if (explicitUserNo) {
    return { ...base, userNo: explicitUserNo, source: 'manifest.sub2api.userNo' };
  }

  const lastSegment = lastNonEmptySegment(packageId);
  if (lastSegment) {
    const userNo = sanitizeShortCode(lastSegment);
    if (isUsableSubject(userNo)) {
      return { ...base, userNo, source: 'manifest.package.id.lastSegment' };
    }
  }

  const packageUserNo = sanitizeShortCode(packageId);
  if (isUsableSubject(packageUserNo)) {
    return { ...base, userNo: packageUserNo, source: 'manifest.package.id' };
  }

  const marketUserNo = sanitizeShortCode(base.marketEmployeeId);
  if (isUsableSubject(marketUserNo)) {
    return { ...base, userNo: marketUserNo, source: 'marketEmployeeId' };
  }

  return null;
}

export function hashSub2ApiSubject(scope: Sub2ApiSubject['scope'], userNo: string): string {
  return createHash('sha256')
    .update(`${scope}:${userNo}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
}

