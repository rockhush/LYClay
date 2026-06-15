import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach, vi } from 'vitest';

const uiStateMock = vi.hoisted(() => ({
  state: null as null | {
    version: 1;
    updatedAt: number;
    workspaces: {
      currentWorkspaceId: string | null;
      currentWorkspacePath: string | null;
      temporaryWorkspaces: Array<{
        id: string;
        name: string;
        agentId: string;
        agentName: string;
        path: string;
        createdAt: number;
        lastAccessedAt: number;
      }>;
    };
    chat: {
      sessionWorkspaceIds: Record<string, string>;
      customSessionLabels: Record<string, string>;
    };
  },
}));

const pathsMock = vi.hoisted(() => ({
  openClawConfigDir: '',
  openClawSkillsDir: '',
  dataDir: '',
}));

vi.mock('../../electron/utils/ui-state', () => ({
  readUiState: () => uiStateMock.state ?? ({
    version: 1,
    updatedAt: Date.now(),
    workspaces: {
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      temporaryWorkspaces: [],
    },
    chat: {
      sessionWorkspaceIds: {},
      customSessionLabels: {},
    },
  }),
}));

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => pathsMock.openClawConfigDir,
  getOpenClawSkillsDir: () => pathsMock.openClawSkillsDir,
  getDataDir: () => pathsMock.dataDir,
}));

import { assertPathInsideRoot, evaluatePathPolicy } from '../../electron/security/path-policy';
import { clearPathGrants, grantDialogPaths, grantPathAccess } from '../../electron/security/permission-store';
import { matchSensitivePath } from '../../electron/security/sensitive-paths';

async function makeTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'clawx-security-'));
}

describe('path security policy', () => {
  beforeEach(() => {
    clearPathGrants();
    uiStateMock.state = null;
    const root = join(tmpdir(), 'clawx-security-path-policy-defaults');
    pathsMock.openClawConfigDir = join(root, 'openclaw');
    pathsMock.openClawSkillsDir = join(root, 'openclaw', 'skills');
    pathsMock.dataDir = join(root, 'lyclaw');
  });

  it('detects common sensitive paths', () => {
    expect(matchSensitivePath(join('C:\\Users\\Leon', '.ssh', 'id_rsa'))?.category).toContain('sensitive-segment');
    expect(matchSensitivePath(join('/home/leon/project', '.env.local'))?.category).toBe('env-file');
    expect(matchSensitivePath(join('/home/leon/.aws', 'credentials'))?.category).toContain('sensitive-segment');
  });

  it('allows reads inside an explicit allowed root', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'package.json');
    await writeFile(filePath, '{}', 'utf8');

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('allow');
  });

  it('denies paths outside authorized roots', async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    const filePath = join(outside, 'notes.txt');
    await writeFile(filePath, 'secret', 'utf8');

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('PATH_OUTSIDE_AUTHORIZED_ROOTS');
  });

  it('blocks sensitive paths even when the root is authorized', async () => {
    const root = await makeTempRoot();
    const sshDir = join(root, '.ssh');
    await mkdir(sshDir);
    const keyPath = join(sshDir, 'id_ed25519');
    await writeFile(keyPath, 'private-key', 'utf8');

    const result = await evaluatePathPolicy({
      path: keyPath,
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('blocks .env.local inside an authorized workspace', async () => {
    const root = await makeTempRoot();
    const envPath = join(root, '.env.local');
    await writeFile(envPath, 'API_KEY=fake', 'utf8');

    const result = await evaluatePathPolicy({
      path: envPath,
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('blocks cloud credentials inside an authorized workspace', async () => {
    const root = await makeTempRoot();
    const awsDir = join(root, '.aws');
    await mkdir(awsDir);
    const credentialsPath = join(awsDir, 'credentials');
    await writeFile(credentialsPath, '[default]\naws_access_key_id=fake', 'utf8');

    const result = await evaluatePathPolicy({
      path: credentialsPath,
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('blocks browser login databases inside an authorized workspace', async () => {
    const root = await makeTempRoot();
    const browserDir = join(root, 'Google', 'Chrome', 'User Data', 'Default');
    await mkdir(browserDir, { recursive: true });
    const loginDataPath = join(browserDir, 'Login Data');
    await writeFile(loginDataPath, 'sqlite-ish', 'utf8');

    const result = await evaluatePathPolicy({
      path: loginDataPath,
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('allows a session grant created from native selection', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'attachment.png');
    await writeFile(filePath, 'png', 'utf8');

    await grantPathAccess(filePath, {
      capabilities: ['read', 'stage'],
      source: 'dialog:openFile',
    });

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'stage',
      source: 'api:files:stage-paths',
    });

    expect(result.decision.action).toBe('allow');
  });

  it('allows files under a directory grant created from native folder selection', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'nested.txt');
    await writeFile(filePath, 'hello', 'utf8');

    await grantDialogPaths([root], {
      directory: true,
      source: 'dialog:openDirectory',
    });

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'read',
      source: 'fs:readFile',
    });

    expect(result.decision.action).toBe('allow');
  });

  it('allows files under the current UI workspace persisted in main state', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'README.md');
    await writeFile(filePath, '# Workspace', 'utf8');
    uiStateMock.state = {
      version: 1,
      updatedAt: Date.now(),
      workspaces: {
        currentWorkspaceId: 'temp-root',
        currentWorkspacePath: root,
        temporaryWorkspaces: [{
          id: 'temp-root',
          name: 'Temp Root',
          agentId: 'temp',
          agentName: 'Temp Root',
          path: root,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        }],
      },
      chat: {
        sessionWorkspaceIds: {},
        customSessionLabels: {},
      },
    };

    const result = await evaluatePathPolicy({
      path: filePath,
      capability: 'open',
      source: 'shell:openExternal',
    });

    expect(result.decision.action).toBe('allow');
  });

  it('allows read access to ordinary files under the OpenClaw skills root', async () => {
    const root = await makeTempRoot();
    const skillsRoot = join(root, 'skills');
    const skillRoot = join(skillsRoot, 'ppt-master');
    const projectRoot = join(skillRoot, 'projects', 'deck-1');
    const projectFile = join(projectRoot, 'sources', 'content.md');
    const packageFile = join(skillRoot, 'SKILL.md');
    await mkdir(join(projectRoot, 'sources'), { recursive: true });
    await writeFile(projectFile, '# content', 'utf8');
    await writeFile(packageFile, 'name: ppt-master', 'utf8');
    pathsMock.openClawConfigDir = root;
    pathsMock.openClawSkillsDir = skillsRoot;
    pathsMock.dataDir = join(root, 'lyclaw');

    const projectResult = await evaluatePathPolicy({
      path: projectFile,
      capability: 'read',
      source: 'api:files:thumbnails',
    });
    const packageResult = await evaluatePathPolicy({
      path: packageFile,
      capability: 'read',
      source: 'api:files:thumbnails',
    });

    expect(projectResult.decision.action).toBe('allow');
    expect(packageResult.decision.action).toBe('allow');
  });

  it('still blocks sensitive files under the OpenClaw skills root', async () => {
    const root = await makeTempRoot();
    const skillsRoot = join(root, 'skills');
    const skillRoot = join(skillsRoot, 'unsafe-skill');
    const envFile = join(skillRoot, '.env.local');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(envFile, 'OPENAI_API_KEY=fake', 'utf8');
    pathsMock.openClawConfigDir = root;
    pathsMock.openClawSkillsDir = skillsRoot;
    pathsMock.dataDir = join(root, 'lyclaw');

    const result = await evaluatePathPolicy({
      path: envFile,
      capability: 'read',
      source: 'api:files:thumbnails',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('SENSITIVE_PATH');
  });

  it('does not authorize an external directory through a symlink inside the skills root', async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    const skillsRoot = join(root, 'skills');
    const skillRoot = join(skillsRoot, 'ppt-master');
    const outsideFile = join(outside, 'content.md');
    await mkdir(skillRoot, { recursive: true });
    await writeFile(outsideFile, '# outside', 'utf8');
    pathsMock.openClawConfigDir = root;
    pathsMock.openClawSkillsDir = skillsRoot;
    pathsMock.dataDir = join(root, 'lyclaw');

    try {
      await symlink(outside, join(skillRoot, 'projects'), 'dir');
    } catch {
      return;
    }

    const result = await evaluatePathPolicy({
      path: join(skillRoot, 'projects', 'content.md'),
      capability: 'read',
      source: 'api:files:thumbnails',
    });

    expect(result.decision.action).toBe('deny');
    expect(result.decision.action === 'deny' ? result.decision.code : '').toBe('PATH_OUTSIDE_AUTHORIZED_ROOTS');
  });

  it('does not let a single-file grant authorize sibling files', async () => {
    const root = await makeTempRoot();
    const selectedFile = join(root, 'selected.txt');
    const siblingFile = join(root, 'sibling.txt');
    await writeFile(selectedFile, 'selected', 'utf8');
    await writeFile(siblingFile, 'sibling', 'utf8');

    await grantPathAccess(selectedFile, {
      capabilities: ['read', 'stage'],
      source: 'dialog:openFile',
    });

    const selectedResult = await evaluatePathPolicy({
      path: selectedFile,
      capability: 'stage',
      source: 'api:files:stage-paths',
    });
    const siblingResult = await evaluatePathPolicy({
      path: siblingFile,
      capability: 'stage',
      source: 'api:files:stage-paths',
    });

    expect(selectedResult.decision.action).toBe('allow');
    expect(siblingResult.decision.action).toBe('deny');
    expect(siblingResult.decision.action === 'deny' ? siblingResult.decision.code : '').toBe('PATH_OUTSIDE_AUTHORIZED_ROOTS');
  });

  it('does not allow delete or execute in the first-stage path policy', async () => {
    const root = await makeTempRoot();
    const filePath = join(root, 'script.js');
    await writeFile(filePath, 'console.log(1)', 'utf8');

    const deleteDecision = await evaluatePathPolicy({
      path: filePath,
      capability: 'delete',
      allowedRoots: [root],
      source: 'test',
    });
    const executeDecision = await evaluatePathPolicy({
      path: filePath,
      capability: 'execute',
      allowedRoots: [root],
      source: 'test',
    });

    expect(deleteDecision.decision.action).toBe('deny');
    expect(executeDecision.decision.action).toBe('deny');
  });

  it('denies symlink escape when the platform permits symlink creation', async () => {
    const root = await makeTempRoot();
    const outside = await makeTempRoot();
    const outsideFile = join(outside, 'outside.txt');
    const linkPath = join(root, 'link-out');
    await writeFile(outsideFile, 'outside', 'utf8');

    try {
      await symlink(outside, linkPath, 'dir');
    } catch {
      return;
    }

    const result = await evaluatePathPolicy({
      path: join(linkPath, 'outside.txt'),
      capability: 'read',
      allowedRoots: [root],
      source: 'test',
    });

    expect(result.decision.action).toBe('deny');
  });

  it('rejects session transcript paths outside the expected sessions directory', async () => {
    const sessionsDir = await makeTempRoot();
    const outsideDir = await makeTempRoot();
    const outsideTranscript = join(outsideDir, 'session.jsonl');
    await writeFile(outsideTranscript, '{}\n', 'utf8');

    await expect(assertPathInsideRoot(outsideTranscript, sessionsDir)).rejects.toThrow('outside required root');
  });
});
