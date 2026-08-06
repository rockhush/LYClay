import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendJsonMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const captureLogErrorSnapshotMock = vi.fn(async () => {});

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/utils/log-observability', () => ({
  captureLogErrorSnapshot: (...args: unknown[]) => captureLogErrorSnapshotMock(...args),
}));

function makeReq(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function makeRes(): ServerResponse {
  return {} as ServerResponse;
}

describe('handleLogRoutes POST /api/log/run-failure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    parseJsonBodyMock.mockResolvedValue({});
    captureLogErrorSnapshotMock.mockResolvedValue(undefined);
  });

  it('captures a backendRunStopped report as a blocking chat.run_error snapshot', async () => {
    parseJsonBodyMock.mockResolvedValue({
      runId: 'run-stuck-1',
      sessionKey: 'agent:main:main',
      errorCode: 'BACKEND_RUN_STOPPED',
      message: '后端 Agent 服务已停止响应',
      metadata: { reason: 'hasTrackedUserRun-after-abort' },
    });

    const { handleLogRoutes } = await import('@electron/api/routes/logs');
    const handled = await handleLogRoutes(
      makeReq('POST'),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/log/run-failure'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
    expect(captureLogErrorSnapshotMock).toHaveBeenCalledTimes(1);
    const input = captureLogErrorSnapshotMock.mock.calls[0][0];
    expect(input).toEqual(expect.objectContaining({
      userImpact: 'blocking',
      operationKind: 'user_chat',
      failureStage: 'backend_run_stuck',
      eventName: 'chat.run_error',
      errorCode: 'CHAT_RUN_ERROR',
      level: 'error',
      source: 'chat',
      runId: 'run-stuck-1',
      sessionKey: 'agent:main:main',
      message: '后端 Agent 服务已停止响应',
    }));
    expect(input.metadata).toEqual(expect.objectContaining({
      reportedErrorCode: 'BACKEND_RUN_STOPPED',
    }));
  });

  it('returns 200 without capturing when sessionKey is missing', async () => {
    parseJsonBodyMock.mockResolvedValue({
      runId: 'run-stuck-2',
      message: 'no session',
    });

    const { handleLogRoutes } = await import('@electron/api/routes/logs');
    const handled = await handleLogRoutes(
      makeReq('POST'),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/log/run-failure'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, { success: true });
    expect(captureLogErrorSnapshotMock).not.toHaveBeenCalled();
  });

  it('does not handle other log routes on POST /api/log/run-failure path mismatch', async () => {
    const { handleLogRoutes } = await import('@electron/api/routes/logs');
    const handled = await handleLogRoutes(
      makeReq('GET'),
      makeRes(),
      new URL('http://127.0.0.1:13210/api/logs'),
      {} as never,
    );
    // GET /api/logs is an existing route; ensure run-failure POST didn't break it
    expect(handled).toBe(true);
    expect(captureLogErrorSnapshotMock).not.toHaveBeenCalled();
  });
});
