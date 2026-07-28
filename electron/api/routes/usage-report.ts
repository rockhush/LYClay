/**
 * Usage Report API routes
 *
 * Routes:
 *   POST /api/usage-report/token-consume    - append a single token-consume record
 *   POST /api/usage-report/skill-download   - append a single skill-download record
 *   POST /api/usage-report/skill-invoke     - append a single skill-invoke record
 *   POST /api/usage-report/execution        - append a single execution record
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
  recordExecution,
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
        execution_id?: string;
        agent_id?: string;
        skill_source?: string;
        invoke_mode?: 'user_selected' | 'model_selected';
        invoke_time?: string;
        invoke_end_time?: string;
        status?: 'success' | 'failed' | 'cancelled' | 'unknown';
        error_message?: string;
        create_date?: string;
        update_date?: string;
      }>(req);
      const skillId = (body.skillId || '').trim();
      if (!skillId) {
        sendJson(res, 200, { success: true, queued: false, reason: 'noop' });
        return true;
      }
      await recordSkillInvoke({
        skillId,
        count: typeof body.count === 'number' ? body.count : 1,
        invokeTime: body.invoke_time ?? body.invokeTime ?? body.date,
        invoke_time: body.invoke_time ?? body.invokeTime ?? body.date,
        execution_id: body.execution_id,
        agent_id: body.agent_id,
        skill_source: body.skill_source,
        invoke_mode: body.invoke_mode,
        invoke_end_time: body.invoke_end_time,
        status: body.status,
        error_message: body.error_message,
        create_date: body.create_date,
        update_date: body.update_date,
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

  if (url.pathname === '/api/usage-report/execution' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        execution_id?: string;
        conversation_id?: string;
        turn_index?: number;
        entry_source?: 'chat' | 'digital_employee' | 'schedule';
        agent_type?: 'normal' | 'digital_employee';
        agent_id?: string;
        model_id?: string;
        status?: 'success' | 'failed' | 'cancelled';
        started_at?: string;
        ended_at?: string;
        first_response_ms?: number;
        input_tokens?: number;
        output_tokens?: number;
        cache_read_tokens?: number;
        create_date?: string;
        update_date?: string;
        error_stage?: 'client' | 'gateway' | 'model';
        error_message?: string;
      }>(req);
      const executionId = (body.execution_id || '').trim();
      const conversationId = (body.conversation_id || '').trim();
      const agentId = (body.agent_id || '').trim();
      const modelId = (body.model_id || '').trim();
      const status = body.status;
      if (!executionId || !conversationId || !agentId || !modelId || !status) {
        sendJson(res, 200, { success: true, queued: false, reason: 'noop' });
        return true;
      }
      await recordExecution({
        execution_id: executionId,
        conversation_id: conversationId,
        turn_index: typeof body.turn_index === 'number' ? body.turn_index : undefined,
        entry_source: body.entry_source ?? 'chat',
        agent_type: body.agent_type ?? 'normal',
        agent_id: agentId,
        model_id: modelId,
        status,
        started_at: body.started_at,
        ended_at: body.ended_at,
        first_response_ms: body.first_response_ms,
        input_tokens: body.input_tokens,
        output_tokens: body.output_tokens,
        cache_read_tokens: body.cache_read_tokens,
        create_date: body.create_date,
        update_date: body.update_date,
        error_stage: body.error_stage,
        error_message: body.error_message,
      });
      sendJson(res, 200, { success: true, queued: true });
    } catch (error) {
      logger.warn('[UsageReportAPI] execution append failed:', error);
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
          execution: status.queue.execution.length,
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
