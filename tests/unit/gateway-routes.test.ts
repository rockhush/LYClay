import { Readable } from 'stream';
import type { IncomingMessage, ServerResponse } from 'http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostApiContext } from '@electron/api/context';
import { handleGatewayRoutes } from '@electron/api/routes/gateway';

vi.mock('@electron/utils/store', () => ({
  getSetting: vi.fn(async () => 'clawx-route-token'),
}));

function createResponse() {
  const headers = new Map<string, string>();
  let body = '';
  const res = {
    statusCode: 0,
    setHeader: (name: string, value: string) => {
      headers.set(name, value);
    },
    end: (value: string) => {
      body = value;
    },
  } as unknown as ServerResponse;

  return {
    res,
    get json() {
      return JSON.parse(body) as Record<string, unknown>;
    },
    get statusCode() {
      return (res as ServerResponse).statusCode;
    },
    headers,
  };
}

function createRequest(method: string, body?: unknown): IncomingMessage {
  if (body === undefined) {
    return { method } as IncomingMessage;
  }
  const raw = JSON.stringify(body);
  const req = Readable.from([raw]) as IncomingMessage;
  req.method = method;
  req.headers = {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(raw)),
  };
  return req;
}

function createContext() {
  const gatewayManager = {
    getLatestEmptyFinalDiagnostic: vi.fn(() => ({
      runId: 'run-empty-final',
      sessionKey: 'agent:main:main',
      recoveryResult: { recovered: false, reason: 'lock-owned-by-other-process' },
    })),
    hasTrackedUserRunForSession: vi.fn(() => false),
    recoverStaleSessionAfterEmptyFinal: vi.fn(async () => ({
      ok: true,
      recovered: true,
      sessionKey: 'agent:main:main',
      previousStatus: 'processing',
      nextStatus: 'stale-recovered',
      removedLockPath: 'session.jsonl.lock',
      reason: 'stale-empty-final',
    })),
  };

  return {
    gatewayManager,
    clawHubService: {},
    eventBus: {},
    mainWindow: null,
  } as unknown as HostApiContext & { gatewayManager: typeof gatewayManager };
}

describe('gateway session recovery routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the cached empty-final diagnostic for a session', async () => {
    const ctx = createContext();
    const response = createResponse();
    const handled = await handleGatewayRoutes(
      createRequest('GET'),
      response.res,
      new URL('http://127.0.0.1/api/sessions/empty-final-diagnostic?sessionKey=agent%3Amain%3Amain'),
      ctx,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      success: true,
      hasTrackedActiveRun: false,
      diagnostic: {
        runId: 'run-empty-final',
        recoveryResult: { reason: 'lock-owned-by-other-process' },
      },
    });
    expect(ctx.gatewayManager.getLatestEmptyFinalDiagnostic).toHaveBeenCalledWith('agent:main:main');
  });

  it('recovers a stale empty-final session through the Main gateway route', async () => {
    const ctx = createContext();
    const response = createResponse();
    const handled = await handleGatewayRoutes(
      createRequest('POST', { sessionKey: 'agent:main:main' }),
      response.res,
      new URL('http://127.0.0.1/api/sessions/recover-stale'),
      ctx,
    );

    expect(handled).toBe(true);
    expect(response.statusCode).toBe(200);
    expect(response.json).toMatchObject({
      success: true,
      result: {
        ok: true,
        recovered: true,
        nextStatus: 'stale-recovered',
      },
    });
    expect(ctx.gatewayManager.recoverStaleSessionAfterEmptyFinal).toHaveBeenCalledWith('agent:main:main');
  });
});
