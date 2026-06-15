import { describe, expect, it } from 'vitest';
import {
  evaluateSkillFrontmatterPermissions,
  evaluateSkillManifestPermissions,
  diffSkillManifestPermissions,
  parseSkillPermissionsFromFrontmatter,
  requiresSkillPermissionConfirmation,
} from '@electron/security/skill-permission-policy';

describe('skill manifest permission policy', () => {
  it('uses Workspace base permissions when a Skill manifest omits permissions', () => {
    const result = evaluateSkillFrontmatterPermissions('name: notes\ndescription: Summarize notes.');

    expect(result.declared).toBe(false);
    expect(result.decision.action).toBe('allow');
    expect(result.permissions).toEqual({
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: [],
      secrets: [],
    });
  });

  it('keeps plugin permissions empty unless they are explicitly declared', () => {
    const result = evaluateSkillManifestPermissions(undefined, 'plugin');

    expect(result.permissions).toEqual({
      filesystem: [],
      network: [],
      commands: [],
      secrets: [],
    });
  });

  it('normalizes supported skill permissions from frontmatter', () => {
    const result = evaluateSkillFrontmatterPermissions(`
permissions:
  filesystem:
    - workspace:read
    - workspace:write
  network: [api.example.com, "*.example.org"]
  commands:
    - python
  secrets: []
`);

    expect(result.decision).toMatchObject({ action: 'allow', risk: 'medium' });
    expect(result.permissions).toEqual({
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: ['api.example.com', '*.example.org'],
      commands: ['python'],
      secrets: [],
    });
  });

  it('blocks unrestricted host, network, shell, and secret access', () => {
    const result = evaluateSkillManifestPermissions({
      filesystem: ['*'],
      network: ['*'],
      commands: ['shell'],
      secrets: ['*'],
    });

    expect(result.decision).toMatchObject({
      action: 'deny',
      code: 'MANIFEST_PERMISSION_DECLARATION_INVALID',
    });
    expect(result.findings).toHaveLength(4);
  });

  it('blocks unknown fields and malformed values', () => {
    const result = evaluateSkillManifestPermissions({
      filesystem: 'workspace:read',
      system: ['admin'],
    }, 'plugin');

    expect(result.subject).toBe('plugin');
    expect(result.decision.action).toBe('deny');
    expect(result.findings.some((finding) => finding.message.includes('unsupported field'))).toBe(true);
    expect(result.findings.some((finding) => finding.message.includes('array of strings'))).toBe(true);
  });

  it('marks unsupported permissions syntax as an invalid declaration', () => {
    const parsed = parseSkillPermissionsFromFrontmatter(`
permissions:
  filesystem: workspace:read
`);
    const result = evaluateSkillManifestPermissions(parsed);

    expect(result.decision.action).toBe('deny');
    expect(result.findings.some((finding) => finding.message.includes('must use a YAML list'))).toBe(true);
  });

  it('computes stable permission diffs for install upgrades', () => {
    expect(diffSkillManifestPermissions(undefined, {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: ['api.example.com'],
      commands: [],
      secrets: [],
    })).toEqual({
      added: ['network:api.example.com'],
      unchanged: [
        'filesystem:workspace:metadata',
        'filesystem:workspace:read',
        'filesystem:workspace:write',
      ],
      removed: [],
    });
  });

  it('does not require confirmation for Workspace base permissions only', () => {
    const diff = diffSkillManifestPermissions(undefined, {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: [],
      commands: [],
      secrets: [],
    });

    expect(requiresSkillPermissionConfirmation(diff)).toBe(false);
  });

  it('requires confirmation when a Skill adds an elevated capability', () => {
    const diff = diffSkillManifestPermissions(undefined, {
      filesystem: ['workspace:metadata', 'workspace:read', 'workspace:write'],
      network: ['api.example.com'],
      commands: [],
      secrets: [],
    });

    expect(requiresSkillPermissionConfirmation(diff)).toBe(true);
  });
});
