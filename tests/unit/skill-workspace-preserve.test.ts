import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  preserveSkillDirectoryOnUninstall,
  restorePreservedSkillDirectory,
  rewriteUiStateWorkspacePaths,
} from '../../electron/utils/skill-workspace-preserve';
import { createEmptyUiState, writeUiState } from '../../electron/utils/ui-state';

let configDir = '';

vi.mock('../../electron/utils/paths', () => ({
  getOpenClawConfigDir: () => configDir,
}));

describe('skill-workspace-preserve', () => {
  let tempRoot = '';

  beforeEach(async () => {
    tempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lyclaw-preserve-'));
    configDir = path.join(tempRoot, 'openclaw');
    await fs.promises.mkdir(configDir, { recursive: true });
  });

  afterEach(async () => {
    if (tempRoot) {
      await fs.promises.rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('rewrites workspace paths when a skill directory is moved', () => {
    const state = createEmptyUiState();
    state.workspaces.temporaryWorkspaces = [{
      id: 'ws-1',
      name: 'ontology',
      agentId: 'temp',
      agentName: 'ontology',
      path: 'C:\\openclaw\\skills\\ontology\\data',
      createdAt: 1,
      lastAccessedAt: 1,
    }];
    state.workspaces.currentWorkspacePath = 'C:\\openclaw\\skills\\ontology';

    const next = rewriteUiStateWorkspacePaths(
      state,
      'C:\\openclaw\\skills\\ontology',
      'C:\\openclaw\\.lyclaw\\preserved-skills\\ontology',
    );

    expect(next.workspaces.currentWorkspacePath).toBe('C:\\openclaw\\.lyclaw\\preserved-skills\\ontology');
    expect(next.workspaces.temporaryWorkspaces[0]?.path).toBe(
      'C:\\openclaw\\.lyclaw\\preserved-skills\\ontology\\data',
    );
  });

  it('preserves skill directory on uninstall and restores it on reinstall', async () => {
    const skillsDir = path.join(configDir, 'skills', 'ontology');
    await fs.promises.mkdir(skillsDir, { recursive: true });
    await fs.promises.writeFile(path.join(skillsDir, 'note.txt'), 'workspace-data', 'utf8');

    writeUiState({
      ...createEmptyUiState(),
      workspaces: {
        currentWorkspaceId: 'ws-1',
        currentWorkspacePath: skillsDir,
        temporaryWorkspaces: [{
          id: 'ws-1',
          name: 'ontology',
          agentId: 'temp',
          agentName: 'ontology',
          path: skillsDir,
          createdAt: 1,
          lastAccessedAt: 1,
        }],
      },
    });

    const preserved = await preserveSkillDirectoryOnUninstall(skillsDir, 'ontology');
    expect(preserved).toBe(path.join(configDir, '.lyclaw', 'preserved-skills', 'ontology'));
    expect(fs.existsSync(skillsDir)).toBe(false);
    expect(fs.existsSync(path.join(preserved!, 'note.txt'))).toBe(true);

    const restored = await restorePreservedSkillDirectory('ontology', skillsDir);
    expect(restored).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, 'note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(configDir, '.lyclaw', 'preserved-skills', 'ontology'))).toBe(false);
  });
});
