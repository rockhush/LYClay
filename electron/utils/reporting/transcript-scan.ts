/**
 * Transcript-based token-consume scanner.
 *
 * The renderer's streaming `final` event payload doesn't reliably carry
 * `usage` — that field is only guaranteed to exist in the OpenClaw session
 * transcript .jsonl files (which already power the dashboard's token-usage
 * page). Scanning those files at flush time is therefore the truth source:
 * whatever the dashboard sees, the uploader queues.
 *
 * A persistent ISO-timestamp cursor (`usageReportTokenScanCursor`) prevents
 * double-counting across restarts — only entries strictly newer than the
 * cursor are queued.
 */

import { logger } from '../logger';
import { getSetting, setSetting } from '../store';
import { getRecentTokenUsageHistory, type TokenUsageHistoryEntry } from '../token-usage';
import { appendTokenConsumeRecord } from './queue';
import { resolveWorkNo } from './work-no';

// 200 is plenty: even a heavy day rarely produces this many assistant turns,
// and the dashboard already caps its own page at much less. We re-scan from
// the cursor each call so anything older than the limit window is ignored
// only on a brand-new install.
const SCAN_WINDOW_LIMIT = 200;

function isFiniteIsoTimestamp(value: string | null | undefined): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

function isQueueable(entry: TokenUsageHistoryEntry): boolean {
  if (entry.usageStatus !== 'available') return false;
  if (!entry.model || entry.model.trim().length === 0) return false;
  if (!Number.isFinite(entry.totalTokens) || entry.totalTokens <= 0) return false;
  if (!isFiniteIsoTimestamp(entry.timestamp)) return false;
  return true;
}

export interface TranscriptScanResult {
  scanned: number;
  queued: number;
  newCursor: string | null;
  skippedReasons: Record<string, number>;
}

/**
 * Scan all session transcripts for assistant `usage` entries newer than the
 * persistent cursor and queue each as a token-consume record. Returns a
 * summary the caller can log for diagnostics.
 */
export async function scanTranscriptsForTokenConsume(): Promise<TranscriptScanResult> {
  const cursor = (await getSetting('usageReportTokenScanCursor')) || null;
  const cursorMs = cursor && isFiniteIsoTimestamp(cursor) ? Date.parse(cursor) : 0;

  const entries = await getRecentTokenUsageHistory(SCAN_WINDOW_LIMIT);
  // getRecentTokenUsageHistory returns newest-first; iterate oldest-first
  // so cursor advances monotonically and a mid-iteration crash leaves the
  // cursor at the latest fully-queued entry rather than the newest seen.
  const ordered = [...entries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const skippedReasons: Record<string, number> = {};
  const bump = (reason: string) => {
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };

  let queued = 0;
  let newCursor = cursor;
  let newCursorMs = cursorMs;
  // workNo is resolved once per scan: a session-long DingTalk login is the
  // overwhelmingly common case, and resolving inside the loop would re-read
  // electron-store for every transcript line.
  const workNo = await resolveWorkNo();

  for (const entry of ordered) {
    const ts = entry.timestamp;
    const tsMs = Date.parse(ts);
    if (!Number.isFinite(tsMs)) {
      bump('invalid-timestamp');
      continue;
    }
    if (tsMs <= cursorMs) {
      bump('older-than-cursor');
      continue;
    }
    if (!isQueueable(entry)) {
      // Even when not queueable, we advance the cursor: a malformed/empty
      // entry shouldn't cause us to re-evaluate it forever.
      bump(entry.usageStatus !== 'available' ? `usage-${entry.usageStatus}` : 'no-tokens-or-model');
      if (tsMs > newCursorMs) {
        newCursor = ts;
        newCursorMs = tsMs;
      }
      continue;
    }
    try {
      await appendTokenConsumeRecord({
        workNo,
        model: entry.model!,
        consume: entry.totalTokens,
        consumeTime: entry.timestamp,
      });
      queued += 1;
      newCursor = ts;
      newCursorMs = tsMs;
    } catch (error) {
      logger.warn(`[UsageReport] transcript scan failed to queue ${entry.sessionId}@${ts}:`, error);
      // Don't advance cursor past a failed record; we'll retry next scan.
      break;
    }
  }

  if (newCursor && newCursor !== cursor) {
    await setSetting('usageReportTokenScanCursor', newCursor);
  }

  return {
    scanned: entries.length,
    queued,
    newCursor,
    skippedReasons,
  };
}
