/**
 * Usage Report API routes
 *
 * Routes:
 *   POST /api/usage-report/token-consume    - append a single token-consume record
 *   POST /api/usage-report/skill-download   - append a single skill-download record
 *   POST /api/usage-report/skill-invoke     - append a single skill-invoke record
 *   POST /api/usage-report/flush            - trigger an immediate upload + queue clear
 *   GET  /api/usage-report/status           - current queue size and last upload timestamps
 *
 * Renderer code MUST go through these routes (via `host-api`) and never
 * `fetch()` the backend directly — so workNo is filled server-side from the
 * persisted DingTalk session and the queue is single-sourced in main.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { logger } from '../../utils/logger';
import {
  flushUsageReports,
  getReportingStatus,
  recordSkillDownload,
  recordSkillInvoke,
  recordTokenConsume,
} from '../../utils/reporting';

export async function handleUsageReportRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/usage-report/token-consume' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        model?: string;
        consume?: number;
        consumeTime?: string;
        date?: string;
      }>(req);
      const model = (body.model || '').trim();
      const consume = typeof body.consume === 'number' ? body.consume : 0;
      if (!model || consume <= 0) {
        sendJson(res, 200, { success: true, queued: false, reason: 'noop' });
        return true;
      }
      await recordTokenConsume({ model, consume, consumeTime: body.consumeTime ?? body.date });
      sendJson(res, 200, { success: true, queued: true });
    } catch (error) {
      logger.warn('[UsageReportAPI] token-consume append failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/usage-report/skill-download' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        skillId?: string;
        count?: number;
        downloadTime?: string;
        date?: string;
      }>(req);
      const skillId = (body.skillId || '').trim();
      if (!skillId) {
        sendJson(res, 200, { success: true, queued: false, reason: 'noop' });
        return true;
      }
      await recordSkillDownload({
        skillId,
        count: typeof body.count === 'number' ? body.count : 1,
        downloadTime: body.downloadTime ?? body.date,
      });
      sendJson(res, 200, { success: true, queued: true });
    } catch (error) {
      logger.warn('[UsageReportAPI] skill-download append failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/usage-report/skill-invoke' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        skillId?: string;
        count?: number;
        invokeTime?: string;
        date?: string;
      }>(req);
      const skillId = (body.skillId || '').trim();
      if (!skillId) {
        sendJson(res, 200, { success: true, queued: false, reason: 'noop' });
        return true;
      }
      await recordSkillInvoke({
        skillId,
        count: typeof body.count === 'number' ? body.count : 1,
        invokeTime: body.invokeTime ?? body.date,
      });
      sendJson(res, 200, { success: true, queued: true });
    } catch (error) {
      logger.warn('[UsageReportAPI] skill-invoke append failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/usage-report/flush' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ reason?: string } | undefined>(req);
      const reason = body?.reason?.trim() || 'manual';
      const result = await flushUsageReports(reason);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      logger.warn('[UsageReportAPI] flush failed:', error);
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  if (url.pathname === '/api/usage-report/status' && req.method === 'GET') {
    try {
      const status = await getReportingStatus();
      sendJson(res, 200, {
        success: true,
        queueSizes: {
          tokenConsume: status.queue.tokenConsume.length,
          skillDownload: status.queue.skillDownload.length,
          skillInvoke: status.queue.skillInvoke.length,
        },
        lastUploadAt: status.lastUploadAt,
      });
    } catch (error) {
      sendJson(res, 500, {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return true;
  }

  return false;
}
