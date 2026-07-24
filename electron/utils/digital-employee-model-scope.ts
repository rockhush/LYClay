import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { getDigitalEmployeeInstallPath } from './digital-employee-storage';

const MODEL_SCOPE_FILE = 'model-scope.json';

export type DigitalEmployeeModelScope = {
  schemaVersion: 1;
  managedBy: 'sub2api';
  scope: 'digitalEmployee';
  userNo: string;
  source:
    | 'manifest.sub2api.userNo'
    | 'manifest.package.id.lastSegment'
    | 'manifest.package.id'
    | 'marketEmployeeId';
  marketEmployeeId: string;
  packageId: string;
  instanceId: string;
  agentId: string;
  provider: {
    providerId: string;
    protocol: 'openai-completions';
    baseUrl: string;
    apiKeyRef: string;
    headers?: Record<string, string>;
  };
  models: Array<string | Record<string, unknown>>;
  defaultModel: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function getModelScopePath(instanceId: string): string {
  return join(getDigitalEmployeeInstallPath(instanceId), MODEL_SCOPE_FILE);
}

function assertDigitalEmployeeModelScope(value: DigitalEmployeeModelScope): void {
  if (value.schemaVersion !== 1) throw new Error('model-scope.json schemaVersion must be 1');
  if (value.managedBy !== 'sub2api') throw new Error('model-scope.json managedBy must be sub2api');
  if (value.scope !== 'digitalEmployee') throw new Error('model-scope.json scope must be digitalEmployee');
  if (!value.instanceId?.trim()) throw new Error('model-scope.json instanceId is required');
  if (!Array.isArray(value.models)) throw new Error('model-scope.json models must be an array');
}

export async function writeDigitalEmployeeModelScope(
  scope: DigitalEmployeeModelScope,
): Promise<void> {
  assertDigitalEmployeeModelScope(scope);
  const installDir = getDigitalEmployeeInstallPath(scope.instanceId);
  await mkdir(installDir, { recursive: true });
  const targetPath = join(installDir, MODEL_SCOPE_FILE);
  const tempPath = join(installDir, `${MODEL_SCOPE_FILE}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(scope, null, 2)}\n`, 'utf8');
  await rename(tempPath, targetPath);
}

export async function readDigitalEmployeeModelScope(
  instanceId: string,
): Promise<DigitalEmployeeModelScope | null> {
  const targetPath = getModelScopePath(instanceId);
  if (!(await pathExists(targetPath))) return null;
  const raw = await readFile(targetPath, 'utf8');
  const parsed = JSON.parse(raw) as DigitalEmployeeModelScope;
  assertDigitalEmployeeModelScope(parsed);
  if (parsed.instanceId !== instanceId) {
    throw new Error('model-scope.json instanceId does not match requested employee');
  }
  return parsed;
}

export async function deleteDigitalEmployeeModelScope(instanceId: string): Promise<void> {
  await rm(getModelScopePath(instanceId), { force: true });
}
