import { describe, expect, it, vi } from 'vitest';
import { handleGatewayPluginApprovalRequested } from '@electron/gateway/plugin-approval-bridge';

describe('gateway plugin approval bridge', () => {
  it('allows a plugin approval after Skill Workshop confirmation allows it', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.approval.get') {
        return {
          request: {
            action: 'apply',
            title: 'Summarizer Skill',
            description: 'Install a generated summarizer skill.',
            toolCallId: 'tool-1',
          },
        };
      }
      return { success: true };
    });
    const approveSkillWorkshopAction = vi.fn(async () => undefined);

    await expect(handleGatewayPluginApprovalRequested({
      id: 'plugin-approval-1',
    }, { request, approveSkillWorkshopAction })).resolves.toBe(true);

    expect(approveSkillWorkshopAction).toHaveBeenCalledWith({
      action: 'apply',
      title: 'Summarizer Skill',
      description: 'Install a generated summarizer skill.',
      toolCallId: 'tool-1',
      source: 'gateway:plugin-approval:skill-workshop',
    });
    expect(request).toHaveBeenCalledWith('plugin.approval.resolve', {
      id: 'plugin-approval-1',
      decision: 'allow-once',
    }, 10000);
  });

  it('denies a plugin approval when Skill Workshop confirmation rejects it', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === 'plugin.approval.get') {
        return {
          request: {
            action: 'apply',
            title: 'Risky Skill',
          },
        };
      }
      return { success: true };
    });
    const approveSkillWorkshopAction = vi.fn(async () => {
      throw new Error('Skill Workshop apply denied by user');
    });

    await expect(handleGatewayPluginApprovalRequested({
      id: 'plugin-approval-2',
    }, { request, approveSkillWorkshopAction })).resolves.toBe(true);

    expect(request).toHaveBeenCalledWith('plugin.approval.resolve', {
      id: 'plugin-approval-2',
      decision: 'deny',
    }, 10000);
  });
});
