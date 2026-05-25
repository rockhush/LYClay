/**
 * Usage-report uploader.
 *
 * Responsibilities:
 * 1. Snapshot the persistent queue.
 * 2. POST each of the three channels to its backend endpoint, always — even
 *    when a channel has no queued records, we send `[]` so each launch
 *    leaves a verifiable trail in the backend access log.
 * 3. On success: drop the channel's records; on failure: requeue so we
 *    retry on the next slot.
 *
 * The flush is idempotent: if called twice concurrently, the second call
 * waits for the first to settle and then sees an already-cleared queue.
 */

import { logger } from '../logger';
import { proxyAwareFetch } from '../proxy-fetch';
import { getReportingEndpoints } from './config';
import {
  detachAllRecords,
  recordSuccessfulUpload,
  restoreFailedRecords,
} from './queue';
import { scanTranscriptsForTokenConsume } from './transcript-scan';
import {
  applyWorkNoToQueueSnapshot,
  ensureWorkNoReady,
} from './work-no';
import type {
  ReportingChannel,
  ReportingChannelDiagnostic,
  ReportingFlushResult,
  SkillDownloadRecord,
  SkillInvokeRecord,
  TokenConsumeRecord,
} from './types';

const RESPONSE_BODY_LOG_LIMIT = 4000;

function truncate(text: string, limit = RESPONSE_BODY_LOG_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…(${text.length} bytes)`;
}

let inFlight: Promise<ReportingFlushResult> | null = null;

interface BackendResponse {
  code?: number;
  msg?: string;
  data?: unknown;
}

/**
 * POST one channel's batch and return a structured diagnostic.
 *
 * The diagnostic is returned (rather than only logged) so the renderer can
 * mirror it into DevTools — main-process logs aren't visible in the renderer
 * Chrome DevTools, which trips up dev workflows.
 */
async function postRecords<T>(
  channel: ReportingChannel,
  url: string,
  records: T[],
): Promise<ReportingChannelDiagnostic> {
  const body = JSON.stringify(records);
  logger.info(
    `[UsageReport][${channel}] >>> POST ${url} `
    + `Content-Type=application/json count=${records.length} body=${truncate(body)}`,
  );
  const diag: ReportingChannelDiagnostic = {
    channel,
    url,
    method: 'POST',
    count: records.length,
    requestBody: truncate(body),
    status: null,
    statusText: null,
    durationMs: 0,
    responseBody: null,
    error: null,
  };
  const startedAt = Date.now();
  let response: Response;
  try {
    response = await proxyAwareFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (error) {
    diag.durationMs = Date.now() - startedAt;
    diag.error = error instanceof Error ? error.message : String(error);
    logger.warn(`[UsageReport][${channel}] <<< network error (${diag.durationMs}ms): ${diag.error}`);
    throw error;
  }
  diag.durationMs = Date.now() - startedAt;
  diag.status = response.status;
  diag.statusText = response.statusText;
  // Always read the raw text first — if the backend returns 400 with a JSON
  // body we still want the message; if it returns HTML we still want to see
  // the first chunk of it instead of swallowing as "Invalid backend response".
  const rawText = await response.text().catch(() => '');
  diag.responseBody = truncate(rawText);
  logger.info(
    `[UsageReport][${channel}] <<< ${response.status} ${response.statusText} `
    + `(${diag.durationMs}ms) body=${truncate(rawText, 2000)}`,
  );
  if (!response.ok) {
    diag.error = `HTTP ${response.status} ${response.statusText}`;
    throw new Error(`HTTP ${response.status} ${response.statusText} body=${rawText.slice(0, 500)}`);
  }
  let json: BackendResponse | null = null;
  if (rawText.length > 0) {
    try {
      json = JSON.parse(rawText) as BackendResponse;
    } catch {
      json = null;
    }
  }
  if (!json || typeof json.code !== 'number') {
    diag.error = `Invalid backend response: ${rawText.slice(0, 200)}`;
    throw new Error(diag.error);
  }
  if (json.code !== 200) {
    diag.error = `Backend rejected: ${json.code} ${json.msg ?? ''}`.trim();
    throw new Error(diag.error);
  }
  return diag;
}

interface ChannelTask<T> {
  channel: ReportingChannel;
  url: string;
  records: T[];
}

/**
 * Push the entire queue to the backend.
 *
 * `reason` is logged so we can tell startup-flush vs daily-12:00-flush apart
 * in user logs when debugging missed uploads.
 */
export async function flushUsageReports(reason: string): Promise<ReportingFlushResult> {
  if (inFlight) {
    return await inFlight;
  }
  const job = (async (): Promise<ReportingFlushResult> => {
    const result: ReportingFlushResult = {
      uploaded: { tokenConsume: 0, skillDownload: 0, skillInvoke: 0 },
      errors: { tokenConsume: null, skillDownload: null, skillInvoke: null },
      diagnostics: [],
    };

    // Scan OpenClaw transcripts for any new assistant token-usage entries
    // before snapshotting the queue, so a freshly-finished assistant turn
    // is captured by the same flush. Failures here must not block uploads
    // of records that are already queued.
    try {
      const scan = await scanTranscriptsForTokenConsume();
      logger.info(
        `[UsageReport] flush(${reason}) transcript scan: scanned=${scan.scanned} `
        + `queued=${scan.queued} cursor=${scan.newCursor ?? 'null'} `
        + `skipped=${JSON.stringify(scan.skippedReasons)}`,
      );
    } catch (error) {
      logger.warn(`[UsageReport] flush(${reason}) transcript scan failed:`, error);
    }

    const detachedRaw = await detachAllRecords();
    const workNo = await ensureWorkNoReady();
    const detached = applyWorkNoToQueueSnapshot(detachedRaw, workNo);
    if (workNo && detachedRaw.tokenConsume.some((record) => !record.workNo?.trim())) {
      logger.info(`[UsageReport] flush(${reason}) backfilled empty workNo with ${workNo}`);
    }

    // Only POST channels that actually have queued records. Empty `[]`
    // payloads were previously sent so the backend access log would show a
    // heartbeat per launch, but ops asked us to drop that — empty channels
    // skip the network round-trip entirely.
    const endpoints = getReportingEndpoints();
    const allTasks: Array<ChannelTask<TokenConsumeRecord | SkillDownloadRecord | SkillInvokeRecord>> = [
      { channel: 'tokenConsume', url: endpoints.tokenConsume, records: detached.tokenConsume },
      { channel: 'skillDownload', url: endpoints.skillDownload, records: detached.skillDownload },
      { channel: 'skillInvoke', url: endpoints.skillInvoke, records: detached.skillInvoke },
    ];
    const tasks = allTasks.filter((t) => t.records.length > 0);

    logger.info(
      `[UsageReport] flush(${reason}) starting: `
      + `token=${detached.tokenConsume.length}, download=${detached.skillDownload.length}, `
      + `invoke=${detached.skillInvoke.length}, posting=${tasks.length}/3 channel(s)`,
    );

    const failed: {
      tokenConsume: TokenConsumeRecord[];
      skillDownload: SkillDownloadRecord[];
      skillInvoke: SkillInvokeRecord[];
    } = { tokenConsume: [], skillDownload: [], skillInvoke: [] };

    // Channels are independent — fire all uploads in parallel so a slow
    // skill-invoke endpoint does not block a token-consume retry.
    // Capture the partial diagnostic even when postRecords throws — the
    // request URL/body is the most useful piece of info on a 400.
    const channelDiags = new Map<ReportingChannel, ReportingChannelDiagnostic>();
    const stubDiagnostic = (task: ChannelTask<unknown>): ReportingChannelDiagnostic => ({
      channel: task.channel,
      url: task.url,
      method: 'POST',
      count: task.records.length,
      requestBody: truncate(JSON.stringify(task.records)),
      status: null,
      statusText: null,
      durationMs: 0,
      responseBody: null,
      error: null,
    });
    await Promise.all(tasks.map(async (task) => {
      const stub = stubDiagnostic(task);
      channelDiags.set(task.channel, stub);
      try {
        const diag = await postRecords(task.channel, task.url, task.records);
        channelDiags.set(task.channel, diag);
        result.uploaded[task.channel] = task.records.length;
        await recordSuccessfulUpload(task.channel, new Date().toISOString());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors[task.channel] = message;
        // Make sure the stub carries the failure reason if postRecords didn't
        // get far enough to populate one (e.g. proxyAwareFetch threw).
        const cur = channelDiags.get(task.channel) ?? stub;
        if (!cur.error) cur.error = message;
        channelDiags.set(task.channel, cur);
        if (task.channel === 'tokenConsume') {
          failed.tokenConsume = task.records as TokenConsumeRecord[];
        } else if (task.channel === 'skillDownload') {
          failed.skillDownload = task.records as SkillDownloadRecord[];
        } else {
          failed.skillInvoke = task.records as SkillInvokeRecord[];
        }
        logger.warn(`[UsageReport] flush(${reason}) ${task.channel} failed:`, message);
      }
    }));
    // Stable order matching the tasks list so DevTools output is predictable.
    for (const task of tasks) {
      const diag = channelDiags.get(task.channel);
      if (diag) result.diagnostics.push(diag);
    }

    if (
      failed.tokenConsume.length > 0
      || failed.skillDownload.length > 0
      || failed.skillInvoke.length > 0
    ) {
      await restoreFailedRecords(failed);
    }

    logger.info(`[UsageReport] flush(${reason}) complete: uploaded=${JSON.stringify(result.uploaded)}, errors=${JSON.stringify(result.errors)}`);
    return result;
  })();

  inFlight = job;
  try {
    return await job;
  } finally {
    inFlight = null;
  }
}
