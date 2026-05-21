/**
 * Shared types for the management/claw/report uploader pipeline.
 *
 * The local persistent queue stores records in EXACTLY the shape required by
 * the backend, so `uploader.ts` can ship them as-is. Records carry workNo at
 * record time (not upload time) because a user may sign out between record
 * and upload — we still want the record attributed to the original user.
 */

export interface TokenConsumeRecord {
  /** DingTalk jobNumber (workNo). Empty string if user not yet signed in. */
  workNo: string;
  /** Model identifier (e.g. "gpt-4o-mini", "claude-sonnet-4"). */
  model: string;
  /** Total tokens consumed for this assistant turn. Always a non-negative integer. */
  consume: number;
  /**
   * "YYYY-MM-DD HH:MM:SS" in local time. The backend uses `consumeTime` as the
   * field name (not `date` like the skill endpoints), and expects seconds-
   * precision so coincident events from the same minute don't collide.
   */
  consumeTime: string;
}

export interface SkillDownloadRecord {
  workNo: string;
  /** Skill identifier (slug from openclaw / company marketplace). */
  skillId: string;
  count: number;
  /**
   * "YYYY-MM-DD HH:MM:SS" in local time. The backend uses `downloadTime` as
   * the field name (not `date` like the skill-invoke endpoint), and expects
   * seconds-precision so coincident installs from the same minute don't
   * collide.
   */
  downloadTime: string;
}

export interface SkillInvokeRecord {
  workNo: string;
  skillId: string;
  count: number;
  /**
   * "YYYY-MM-DD HH:MM:SS" in local time. The backend uses `invokeTime` as the
   * field name and expects seconds-precision so coincident invocations from
   * the same minute don't collide.
   */
  invokeTime: string;
}

export type ReportingChannel = 'tokenConsume' | 'skillDownload' | 'skillInvoke';

export interface UsageReportQueueSnapshot {
  tokenConsume: TokenConsumeRecord[];
  skillDownload: SkillDownloadRecord[];
  skillInvoke: SkillInvokeRecord[];
}

export interface ReportingChannelDiagnostic {
  channel: ReportingChannel;
  url: string;
  method: 'POST';
  /** Number of records included in this POST (0 means we sent `[]`). */
  count: number;
  /** Exact JSON string POSTed as request body. */
  requestBody: string;
  /** HTTP status of the response, or null if the request threw before getting one. */
  status: number | null;
  /** Reason text from HTTP status line, when available. */
  statusText: string | null;
  /** Wall-clock duration of the POST in ms. */
  durationMs: number;
  /** Raw response body text (truncated to ~4KB if huge). */
  responseBody: string | null;
  /** Top-level error message if the call failed (network throw or non-200 / non-code-200). */
  error: string | null;
}

export interface ReportingFlushResult {
  /** Per-channel: number of records uploaded successfully (0 if nothing to send). */
  uploaded: Record<ReportingChannel, number>;
  /** Per-channel: error message string if upload failed; null if success or no-op. */
  errors: Record<ReportingChannel, string | null>;
  /**
   * Per-channel request/response trace, returned to the renderer so the UI
   * (or DevTools console) can show exactly what was POSTed and what the
   * backend replied with. Always populated, even on success.
   */
  diagnostics: ReportingChannelDiagnostic[];
}
