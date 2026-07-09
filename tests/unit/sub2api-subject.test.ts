import { describe, expect, it } from 'vitest';
import {
  hashSub2ApiSubject,
  resolveDigitalEmployeeSub2ApiSubject,
  resolveGlobalSub2ApiSubject,
} from '../../electron/utils/sub2api-subject';
import type { DigitalEmployeePackageManifest } from '../../shared/types/digital-employee';

function manifest(id: string, sub2apiUserNo?: string): DigitalEmployeePackageManifest {
  return {
    schemaVersion: 1,
    package: {
      id,
      name: 'Document Analyst',
      version: '1.0.0',
      description: 'Analyze documents.',
    },
    agent: {
      workspaceSource: 'agent/workspace',
    },
    ...(sub2apiUserNo !== undefined ? { sub2api: { userNo: sub2apiUserNo } } : {}),
  };
}

describe('Sub2API subject resolution', () => {
  it('resolves global subject from DingTalk job number before user id', () => {
    expect(resolveGlobalSub2ApiSubject({ jobNumber: ' EMP001 ', userId: 'user-1' })).toEqual({
      scope: 'global',
      userNo: 'EMP001',
      source: 'dingtalk.jobNumber',
    });
  });

  it('falls back to DingTalk user id for global subject', () => {
    expect(resolveGlobalSub2ApiSubject({ jobNumber: ' ', userId: ' user-1 ' })).toEqual({
      scope: 'global',
      userNo: 'user-1',
      source: 'dingtalk.userId',
    });
  });

  it('returns null when global DingTalk identity is missing', () => {
    expect(resolveGlobalSub2ApiSubject({ name: 'No Identity' })).toBeNull();
  });

  it('uses explicit employee Sub2API user number before derived values', () => {
    expect(resolveDigitalEmployeeSub2ApiSubject({
      manifest: manifest('com.lyclaw.employee.document-analyst', 'custom-doc'),
      marketEmployeeId: '123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    })).toMatchObject({
      scope: 'digitalEmployee',
      userNo: 'custom-doc',
      source: 'manifest.sub2api.userNo',
      packageId: 'com.lyclaw.employee.document-analyst',
      packageName: 'Document Analyst',
      marketEmployeeId: '123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    });
  });

  it('derives employee subject from package id last segment', () => {
    expect(resolveDigitalEmployeeSub2ApiSubject({
      manifest: manifest('com.lyclaw.employee.document-analyst'),
      marketEmployeeId: '123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    })?.userNo).toBe('document-analyst');
  });

  it('replaces unsafe characters in a derived employee short code', () => {
    expect(resolveDigitalEmployeeSub2ApiSubject({
      manifest: manifest('com.lyclaw.employee.doc analyst.v2'),
      marketEmployeeId: '123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    })).toMatchObject({
      userNo: 'v2',
      source: 'manifest.package.id.lastSegment',
    });

    expect(resolveDigitalEmployeeSub2ApiSubject({
      manifest: manifest('doc analyst'),
      marketEmployeeId: '123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    })).toMatchObject({
      userNo: 'doc-analyst',
      source: 'manifest.package.id.lastSegment',
    });
  });

  it('falls back to full package id and market id when short code is invalid', () => {
    expect(resolveDigitalEmployeeSub2ApiSubject({
      manifest: manifest('com.lyclaw.employee.!!!'),
      marketEmployeeId: 'market-123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    })).toMatchObject({
      userNo: 'com-lyclaw-employee----',
      source: 'manifest.package.id',
    });

    expect(resolveDigitalEmployeeSub2ApiSubject({
      manifest: manifest('!!!'),
      marketEmployeeId: 'market-123',
      instanceId: 'inst-1',
      agentId: 'agent-1',
    })).toMatchObject({
      userNo: 'market-123',
      source: 'marketEmployeeId',
    });
  });

  it('returns stable short hashes without exposing full user numbers', () => {
    const first = hashSub2ApiSubject('global', 'EMP001');
    const second = hashSub2ApiSubject('global', 'EMP001');

    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{8}$/);
    expect(first).not.toContain('EMP001');
  });
});


