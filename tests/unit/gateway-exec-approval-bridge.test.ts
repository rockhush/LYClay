import { describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleGatewayExecApprovalRequested } from '@electron/gateway/exec-approval-bridge';

describe('gateway exec approval bridge', () => {
  it('allows a runtime exec approval after command policy allows it', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'exec.approval.get') {
        return {
          request: {
            command: 'type README.md',
            cwd: 'D:\\code\\ClawX',
            sessionKey: 'agent:main:main',
            agentId: 'main',
          },
        };
      }
      return { success: true };
    });
    const approveCommand = vi.fn(async () => ({
      command: 'type README.md',
      cwd: 'D:\\code\\ClawX',
      segments: [],
      decision: { action: 'allow' as const, risk: 'low' as const, reasons: ['test'] },
    }));

    await expect(handleGatewayExecApprovalRequested({
      id: 'approval-1',
      request: { commandPreview: 'type README.md' },
    }, { request, approveCommand })).resolves.toBe(true);

    expect(approveCommand).toHaveBeenCalledWith(expect.objectContaining({
      command: 'type README.md',
      cwd: 'D:\\code\\ClawX',
      source: 'gateway:runtime-exec:main',
    }));
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-1',
      decision: 'allow-once',
    }, 10000);
  });

  it('denies a runtime exec approval when command policy rejects it', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'exec.approval.get') {
        return {
          request: {
            command: 'type C:\\Users\\Leon\\.ssh\\id_rsa',
            cwd: 'D:\\code\\ClawX',
            sessionKey: 'agent:main:main',
          },
        };
      }
      return { success: true };
    });
    const approveCommand = vi.fn(async () => {
      throw new Error('Command execution denied');
    });

    await expect(handleGatewayExecApprovalRequested({
      id: 'approval-2',
      request: { commandPreview: 'type C:\\Users\\Leon\\.ssh\\id_rsa' },
    }, { request, approveCommand })).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-2',
      decision: 'deny',
    }, 10000);
  });

  it('uses Skill runtime policy without falling back to normal command confirmation for Skill commands', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'exec.approval.get') {
        return {
          request: {
            command: 'python report.py',
            cwd: 'D:\\code\\ClawX',
            securityContext: {
              skillId: 'safe-skill',
              manifestDigest: 'digest-v1',
            },
          },
        };
      }
      return { success: true };
    });
    const approveSkillCommand = vi.fn(async () => undefined);
    const approveCommand = vi.fn(async () => ({
      command: 'python report.py',
      cwd: 'D:\\code\\ClawX',
      segments: [],
      decision: { action: 'allow' as const, risk: 'low' as const, reasons: ['test'] },
    }));

    await expect(handleGatewayExecApprovalRequested({
      id: 'approval-3',
    }, { request, approveCommand, approveSkillCommand })).resolves.toBe(true);

    expect(approveSkillCommand).toHaveBeenCalledWith({
      context: {
        skillId: 'safe-skill',
        manifestDigest: 'digest-v1',
        source: 'gateway:runtime-exec:skill:safe-skill',
      },
      command: 'python report.py',
      cwd: 'D:\\code\\ClawX',
    });
    expect(approveCommand).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-3',
      decision: 'allow-once',
    }, 10000);
  });

  it('infers Skill runtime context from commands that run inside the managed skills directory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'clawx-exec-skill-infer-'));
    const skillsRoot = path.join(root, 'skills');
    const skillDir = path.join(skillsRoot, 'ppt-master');
    const manifest = [
      '---',
      'name: ppt-master',
      'description: Build presentations.',
      '---',
      '',
      '# PPT Master',
    ].join('\n');
    await mkdir(path.join(skillDir, 'scripts'), { recursive: true });
    await writeFile(path.join(skillDir, 'SKILL.md'), manifest, 'utf8');
    process.env.CLAWX_TEST_OPENCLAW_SKILLS_DIR = skillsRoot;

    const scriptPath = path.join(skillDir, 'scripts', 'project_manager.py');
    const request = vi.fn(async (method: string) => {
      if (method === 'exec.approval.get') {
        return {
          request: {
            command: `uv run python "${scriptPath}" init shenzhen_intro --format ppt169`,
            cwd: root,
          },
        };
      }
      return { success: true };
    });
    const approveSkillCommand = vi.fn(async () => undefined);
    const approveCommand = vi.fn();

    await expect(handleGatewayExecApprovalRequested({
      id: 'approval-inferred-skill',
    }, { request, approveCommand, approveSkillCommand })).resolves.toBe(true);

    expect(approveSkillCommand).toHaveBeenCalledWith({
      context: {
        skillId: 'ppt-master',
        manifestDigest: crypto.createHash('sha256').update(manifest).digest('hex'),
        source: 'gateway:runtime-exec:skill:ppt-master',
      },
      command: `uv run python "${scriptPath}" init shenzhen_intro --format ppt169`,
      cwd: root,
    });
    expect(approveCommand).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-inferred-skill',
      decision: 'allow-once',
    }, 10000);

    delete process.env.CLAWX_TEST_OPENCLAW_SKILLS_DIR;
  });

  it('denies incomplete Skill runtime bindings instead of treating them as normal Agent commands', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'exec.approval.get') {
        return {
          request: {
            command: 'python report.py',
            skillId: 'safe-skill',
          },
        };
      }
      return { success: true };
    });
    const approveCommand = vi.fn();

    await expect(handleGatewayExecApprovalRequested({
      id: 'approval-4',
    }, { request, approveCommand })).resolves.toBe(true);

    expect(approveCommand).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('exec.approval.resolve', {
      id: 'approval-4',
      decision: 'deny',
    }, 10000);
  });
});
