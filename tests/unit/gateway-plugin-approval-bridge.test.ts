import { describe, expect, it, vi } from 'vitest';
import { handleGatewayPluginApprovalRequested } from '@electron/gateway/plugin-approval-bridge';

function skillWorkshopPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 'approval-1',
    request: {
      title: 'Apply workspace skill proposal',
      description: 'Update the weekly report output.',
      allowedDecisions: ['allow-once', 'deny'],
      toolName: 'skill_workshop',
      toolCallId: 'tool-call-1',
      agentId: 'main',
      sessionKey: 'agent:main:main',
      ...overrides,
    },
  };
}

describe('Gateway plugin approval bridge', () => {
  it('resolves a confirmed Skill Workshop action as allow-once', async () => {
    const request = vi.fn(async () => ({}));
    const approve = vi.fn(async () => undefined);

    await expect(handleGatewayPluginApprovalRequested(skillWorkshopPayload(), {
      request,
      approve,
    })).resolves.toBe(true);

    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      action: 'apply',
      title: 'Apply workspace skill proposal',
      toolCallId: 'tool-call-1',
    }));
    expect(request).toHaveBeenCalledWith(
      'plugin.approval.resolve',
      { id: 'approval-1', decision: 'allow-once' },
      10_000,
    );
  });

  it('resolves a rejected confirmation as deny', async () => {
    const request = vi.fn(async () => ({}));
    const approve = vi.fn(async () => {
      throw new Error('denied');
    });

    await handleGatewayPluginApprovalRequested(skillWorkshopPayload(), { request, approve });

    expect(request).toHaveBeenCalledWith(
      'plugin.approval.resolve',
      { id: 'approval-1', decision: 'deny' },
      10_000,
    );
  });

  it('denies unsupported plugin approval requests without prompting', async () => {
    const request = vi.fn(async () => ({}));
    const approve = vi.fn(async () => undefined);

    await expect(handleGatewayPluginApprovalRequested(
      skillWorkshopPayload({ toolName: 'unknown_plugin' }),
      { request, approve },
    )).resolves.toBe(true);

    expect(approve).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith(
      'plugin.approval.resolve',
      { id: 'approval-1', decision: 'deny' },
      10_000,
    );
  });

  it('ignores malformed events without an approval id', async () => {
    const request = vi.fn(async () => ({}));

    await expect(handleGatewayPluginApprovalRequested({ request: {} }, { request })).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});
