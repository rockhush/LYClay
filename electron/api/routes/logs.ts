import type { IncomingMessage, ServerResponse } from 'http';
import { logger } from '../../utils/logger';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { captureLogErrorSnapshot } from '../../utils/log-observability';

export async function handleLogRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/logs' && req.method === 'GET') {
    const tailLines = Number(url.searchParams.get('tailLines') || '100');
    sendJson(res, 200, { content: await logger.readLogFile(Number.isFinite(tailLines) ? tailLines : 100) });
    return true;
  }

  if (url.pathname === '/api/logs/dir' && req.method === 'GET') {
    sendJson(res, 200, { dir: logger.getLogDir() });
    return true;
  }

  if (url.pathname === '/api/logs/files' && req.method === 'GET') {
    sendJson(res, 200, { files: await logger.listLogFiles() });
    return true;
  }

  if (url.pathname === '/api/log/run-failure' && req.method === 'POST') {
    // Renderer-owned blocking failures (e.g. backendRunStopped) that the Main
    // process cannot observe itself are reported here. The route stays
    // fire-and-forget: it returns 200 regardless of capture outcome so the
    // Renderer never blocks or retries on the logging path.
    let payload: { runId?: string; sessionKey?: string; errorCode?: string; message?: string; metadata?: Record<string, unknown> } = {};
    try {
      payload = await parseJsonBody(req) as typeof payload;
    } catch {
      sendJson(res, 200, { success: true });
      return true;
    }

    const { sessionKey, runId, errorCode, message, metadata } = payload;
    if (sessionKey && typeof sessionKey === 'string' && sessionKey.trim()) {
      void captureLogErrorSnapshot({
        userImpact: 'blocking',
        operationKind: 'user_chat',
        failureStage: 'backend_run_stuck',
        level: 'error',
        source: 'chat',
        eventName: 'chat.run_error',
        component: 'gateway-agent',
        errorCode: 'CHAT_RUN_ERROR',
        message: typeof message === 'string' && message.trim() ? message : 'Backend agent stopped responding',
        runId: typeof runId === 'string' && runId.trim() ? runId : undefined,
        sessionKey,
        status: 'failed',
        metadata: {
          reportedErrorCode: typeof errorCode === 'string' ? errorCode : undefined,
          ...metadata,
        },
      }).catch((error) => {
        logger.warn('[log.route] run-failure report capture failed', { error: String(error) });
      });
    }
    sendJson(res, 200, { success: true });
    return true;
  }

  return false;
}
