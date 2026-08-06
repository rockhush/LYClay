/**
 * Preserve request-scoped cancellation when an internal webchat turn becomes
 * a queued follow-up after chat.send has already acknowledged the request.
 */

const ORIGINAL_QUEUED_FOLLOWUP_ABORT = 'const queuedFollowupAbortSignal = inboundEventKind === "room_event" ? internalOpts?.queuedFollowupAbortSignal ?? opts?.abortSignal : void 0;';
const WEBCHAT_AWARE_QUEUED_FOLLOWUP_ABORT = 'const queuedFollowupAbortSignal = (inboundEventKind === "room_event" || isInternalPromptChannel) ? internalOpts?.queuedFollowupAbortSignal ?? opts?.abortSignal : void 0;';

export function hasOpenClawQueuedFollowupAbortPatches(source) {
  return source.includes(WEBCHAT_AWARE_QUEUED_FOLLOWUP_ABORT);
}

export function applyOpenClawQueuedFollowupAbortPatches(source) {
  if (hasOpenClawQueuedFollowupAbortPatches(source)) {
    return { source, patched: false };
  }
  if (!source.includes(ORIGINAL_QUEUED_FOLLOWUP_ABORT)) {
    return { source, patched: false };
  }

  return {
    source: source.replace(
      ORIGINAL_QUEUED_FOLLOWUP_ABORT,
      WEBCHAT_AWARE_QUEUED_FOLLOWUP_ABORT,
    ),
    patched: true,
  };
}
