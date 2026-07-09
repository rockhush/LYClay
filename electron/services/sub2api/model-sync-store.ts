import { getClawXProviderStore } from '../providers/store-instance';

const STORE_KEY = 'sub2apiSyncStatus';

export type Sub2ApiSyncScope = 'global' | 'digitalEmployee';
export type Sub2ApiSyncStatusValue = 'running' | 'success' | 'failed';

export type Sub2ApiSyncStatusRecord = {
  scope: Sub2ApiSyncScope;
  subjectHash: string;
  source: string;
  status: Sub2ApiSyncStatusValue;
  modelCount: number;
  lastStartedAt: string;
  lastSuccessAt: string | null;
  lastFailedAt: string | null;
  updatedAt: string;
  durationMs: number | null;
  errorCode: string | null;
};

export type RecordSub2ApiSyncStartedInput = {
  scope: Sub2ApiSyncScope;
  subjectHash: string;
  source: string;
  now?: string;
};

export type RecordSub2ApiSyncCompletedInput = RecordSub2ApiSyncStartedInput & {
  modelCount: number;
  startedAt?: string;
  errorCode?: string | null;
};

function statusKey(scope: Sub2ApiSyncScope, subjectHash: string): string {
  return `${scope}:${subjectHash}`;
}

function nowIso(value?: string): string {
  return value ?? new Date().toISOString();
}

function durationMs(startedAt: string | undefined, finishedAt: string): number | null {
  if (!startedAt) return null;
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return null;
  return Math.max(0, finished - started);
}

async function readStatusMap(): Promise<Record<string, Sub2ApiSyncStatusRecord>> {
  const store = await getClawXProviderStore();
  return (store.get(STORE_KEY) ?? {}) as Record<string, Sub2ApiSyncStatusRecord>;
}

async function writeStatus(record: Sub2ApiSyncStatusRecord): Promise<void> {
  const store = await getClawXProviderStore();
  const statuses = await readStatusMap();
  statuses[statusKey(record.scope, record.subjectHash)] = record;
  store.set(STORE_KEY, statuses);
}

export async function recordSub2ApiSyncStarted(
  input: RecordSub2ApiSyncStartedInput,
): Promise<Sub2ApiSyncStatusRecord> {
  const timestamp = nowIso(input.now);
  const existing = (await readStatusMap())[statusKey(input.scope, input.subjectHash)];
  const record: Sub2ApiSyncStatusRecord = {
    scope: input.scope,
    subjectHash: input.subjectHash,
    source: input.source,
    status: 'running',
    modelCount: existing?.modelCount ?? 0,
    lastStartedAt: timestamp,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastFailedAt: existing?.lastFailedAt ?? null,
    updatedAt: timestamp,
    durationMs: null,
    errorCode: null,
  };
  await writeStatus(record);
  return record;
}

export async function recordSub2ApiSyncSuccess(
  input: RecordSub2ApiSyncCompletedInput,
): Promise<Sub2ApiSyncStatusRecord> {
  const timestamp = nowIso(input.now);
  const record: Sub2ApiSyncStatusRecord = {
    scope: input.scope,
    subjectHash: input.subjectHash,
    source: input.source,
    status: 'success',
    modelCount: input.modelCount,
    lastStartedAt: input.startedAt ?? timestamp,
    lastSuccessAt: timestamp,
    lastFailedAt: null,
    updatedAt: timestamp,
    durationMs: durationMs(input.startedAt, timestamp),
    errorCode: null,
  };
  await writeStatus(record);
  return record;
}

export async function recordSub2ApiSyncFailure(
  input: RecordSub2ApiSyncCompletedInput,
): Promise<Sub2ApiSyncStatusRecord> {
  const timestamp = nowIso(input.now);
  const existing = (await readStatusMap())[statusKey(input.scope, input.subjectHash)];
  const record: Sub2ApiSyncStatusRecord = {
    scope: input.scope,
    subjectHash: input.subjectHash,
    source: input.source,
    status: 'failed',
    modelCount: input.modelCount,
    lastStartedAt: input.startedAt ?? timestamp,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastFailedAt: timestamp,
    updatedAt: timestamp,
    durationMs: durationMs(input.startedAt, timestamp),
    errorCode: input.errorCode ?? 'unknown',
  };
  await writeStatus(record);
  return record;
}

export async function listSub2ApiSyncStatus(): Promise<Sub2ApiSyncStatusRecord[]> {
  return Object.values(await readStatusMap())
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}
