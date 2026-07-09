import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteDigitalEmployeeModelScope,
  readDigitalEmployeeModelScope,
  writeDigitalEmployeeModelScope,
} from '../../electron/utils/digital-employee-model-scope';

let root: string;
let previousEmployeesDir: string | undefined;

beforeEach(async () => {
  previousEmployeesDir = process.env.CLAWX_DIGITAL_EMPLOYEES_DIR;
  root = join(tmpdir(), `lyclaw-model-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  process.env.CLAWX_DIGITAL_EMPLOYEES_DIR = root;
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  if (previousEmployeesDir === undefined) {
    delete process.env.CLAWX_DIGITAL_EMPLOYEES_DIR;
  } else {
    process.env.CLAWX_DIGITAL_EMPLOYEES_DIR = previousEmployeesDir;
  }
  await rm(root, { recursive: true, force: true });
});

describe('digital employee model scope storage', () => {
  it('writes and reads a schema versioned model scope file', async () => {
    await writeDigitalEmployeeModelScope({
      schemaVersion: 1,
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      userNo: 'document-analyst',
      source: 'manifest.package.id.lastSegment',
      marketEmployeeId: '123',
      packageId: 'com.lyclaw.employee.document-analyst',
      instanceId: 'employee-document-analyst-1',
      agentId: 'agent-1',
      provider: {
        providerId: 'sub2api-employee-document-analyst-1',
        protocol: 'openai-completions',
        baseUrl: 'https://sub2api.internal.example.com/v1',
        apiKeyRef: 'secret:sub2api-employee-document-analyst-1',
      },
      models: ['deepseek-v4-pro'],
      defaultModel: 'sub2api-employee-document-analyst-1/deepseek-v4-pro',
      lastSuccessAt: '2026-07-06T10:00:00.000Z',
      lastError: null,
    });

    const raw = await readFile(join(root, 'employee-document-analyst-1', 'model-scope.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({
      schemaVersion: 1,
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      instanceId: 'employee-document-analyst-1',
      models: ['deepseek-v4-pro'],
    });
    await expect(readDigitalEmployeeModelScope('employee-document-analyst-1'))
      .resolves.toMatchObject({ defaultModel: 'sub2api-employee-document-analyst-1/deepseek-v4-pro' });
  });

  it('returns null when no model scope exists', async () => {
    await expect(readDigitalEmployeeModelScope('missing-employee')).resolves.toBeNull();
  });

  it('rejects unsafe instance ids', async () => {
    await expect(readDigitalEmployeeModelScope('../outside')).rejects.toThrow('Invalid digital employee instanceId');
    await expect(writeDigitalEmployeeModelScope({
      schemaVersion: 1,
      managedBy: 'sub2api',
      scope: 'digitalEmployee',
      userNo: 'x',
      source: 'manifest.sub2api.userNo',
      marketEmployeeId: '123',
      packageId: 'pkg',
      instanceId: '../outside',
      agentId: 'agent-1',
      provider: {
        providerId: 'provider',
        protocol: 'openai-completions',
        baseUrl: 'https://sub2api.internal.example.com/v1',
        apiKeyRef: 'secret:provider',
      },
      models: [],
      defaultModel: null,
      lastSuccessAt: null,
      lastError: null,
    })).rejects.toThrow('Invalid digital employee instanceId');
  });

  it('deletes only the requested model scope file', async () => {
    await mkdir(join(root, 'employee-a'), { recursive: true });
    await mkdir(join(root, 'employee-b'), { recursive: true });
    await writeFile(join(root, 'employee-a', 'model-scope.json'), '{"schemaVersion":1}', 'utf8');
    await writeFile(join(root, 'employee-b', 'model-scope.json'), '{"schemaVersion":1}', 'utf8');

    await deleteDigitalEmployeeModelScope('employee-a');

    await expect(readDigitalEmployeeModelScope('employee-a')).resolves.toBeNull();
    await expect(readFile(join(root, 'employee-b', 'model-scope.json'), 'utf8')).resolves.toContain('schemaVersion');
  });
});
