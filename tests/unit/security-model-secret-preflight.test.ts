import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertGatewayRpcModelSecretsAllowed,
  assertModelSecretsAllowedBeforeSend,
  resetModelSecretPreflightForTests,
} from '@electron/security/model-secret-preflight';
import {
  registerSecurityConfirmationHandlers,
  resetSecurityConfirmationForTests,
} from '@electron/security/confirmation-service';
import {
  clearSecurityAuditEventsForTests,
  listSecurityAuditEvents,
} from '@electron/security/audit-log';

vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const providerToken = 'sk-abcdefghijklmnopqrstuvwxyz1234567890';

function setupConfirmationHarness() {
  let handler: ((event: unknown, response: unknown) => Promise<unknown>) | null = null;
  const sent: unknown[] = [];
  registerSecurityConfirmationHandlers({
    handle: vi.fn((channel: string, nextHandler: typeof handler) => {
      if (channel === 'security:confirmation-response') handler = nextHandler;
    }),
  } as never, {
    isDestroyed: () => false,
    webContents: {
      send: vi.fn((_channel: string, payload: unknown) => sent.push(payload)),
    },
  } as never);

  return {
    sent,
    respond: async (choice: 'deny' | 'allow-once' | 'allow-session') => {
      const request = sent.at(-1) as { id: string };
      if (!handler) throw new Error('missing confirmation response handler');
      await handler({}, { id: request.id, choice });
    },
  };
}

describe('model secret preflight', () => {
  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'clawx-model-secret-'));
    process.env.CLAWX_SECURITY_AUDIT_LOG_PATH = join(root, 'audit-log.jsonl');
    clearSecurityAuditEventsForTests();
    resetSecurityConfirmationForTests();
    resetModelSecretPreflightForTests();
  });

  it('allows ordinary model messages without prompting', async () => {
    const harness = setupConfirmationHarness();

    await expect(assertModelSecretsAllowedBeforeSend('summarize this document', 'gateway:rpc:chat.send'))
      .resolves.toEqual({
        allowed: true,
        matchedTypes: [],
        count: 0,
        risk: 'low',
      });
    expect(harness.sent).toHaveLength(0);
  });

  it('prompts with redacted excerpts before sending a provider token', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertGatewayRpcModelSecretsAllowed('chat.send', {
      message: `please inspect api_key=${providerToken}`,
    });

    await expect.poll(() => harness.sent.length).toBe(1);
    expect(harness.sent[0]).toMatchObject({
      kind: 'model-secret',
      risk: 'high',
      target: {
        secretTypes: expect.arrayContaining(['api-key-assignment']),
        excerpts: [expect.stringContaining('[REDACTED]')],
      },
    });
    expect(JSON.stringify(harness.sent[0])).not.toContain(providerToken);

    await harness.respond('allow-once');
    await expect(pending).resolves.toBeUndefined();
  });

  it('blocks the model send when the user rejects it', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertModelSecretsAllowedBeforeSend(`send ${providerToken}`, 'gateway:rpc:chat.send');

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('deny');
    await expect(pending).rejects.toMatchObject({
      code: 'MODEL_SECRET_DENIED_BY_USER',
    });
  });

  it('remembers an exact model-send approval for this app session', async () => {
    const harness = setupConfirmationHarness();
    const message = `send token=${providerToken}`;
    const pending = assertModelSecretsAllowedBeforeSend(message, 'gateway:rpc:chat.send');

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-session');
    await pending;

    await expect(assertModelSecretsAllowedBeforeSend(message, 'gateway:rpc:chat.send'))
      .resolves.toMatchObject({ allowed: true, count: 1 });
    expect(harness.sent).toHaveLength(1);
  });

  it('records a redacted audit event when a model-send secret is detected', async () => {
    const harness = setupConfirmationHarness();
    const pending = assertModelSecretsAllowedBeforeSend(`send api_key=${providerToken}`, 'gateway:rpc:chat.send');

    await expect.poll(() => harness.sent.length).toBe(1);
    await harness.respond('allow-once');
    await pending;

    const events = listSecurityAuditEvents();
    expect(events).toContainEqual(expect.objectContaining({
      source: 'gateway:rpc:chat.send',
      capability: 'model-secret',
      operation: 'preflight',
      decision: 'prompt',
      risk: 'high',
    }));
    expect(JSON.stringify(events)).not.toContain(providerToken);
  });
});
