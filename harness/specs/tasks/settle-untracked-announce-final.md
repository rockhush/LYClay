---
id: settle-untracked-announce-final
title: Settle foreground chat state from bound announce final events
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Fix foreground chat turns that remain visibly "thinking" when a completed subagent announce final is written to transcript and Gateway is idle, but renderer treats the announce runId as untracked because it differs from the foreground activeRunId.
touchedAreas:
  - harness/specs/tasks/settle-untracked-announce-final.md
  - src/stores/chat/runtime-event-handlers.ts
  - src/stores/chat.ts
  - src/stores/chat/finalize-turn-bridge.ts
  - src/lib/subagent-delegation.ts
  - tests/unit/chat-runtime-event-handlers.test.ts
  - tests/unit/chat-run-lifecycle.test.ts
expectedUserBehavior:
  - When a subagent completes, writes its final result, Gateway becomes idle, and the parent transcript receives the announce wrap-up final, the foreground chat leaves "thinking".
  - The final assistant answer remains visible exactly once.
  - The composer, stop button, sidebar running indicator, and execution graph settle from the same cleared active-run state.
  - Unrelated background announce finals do not clear the foreground chat.
  - Normal foreground finals, tool-round finals, aborts, errors, empty finals, and background-session updates keep their current behavior.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/settle-untracked-announce-final.md
  - pnpm exec vitest run tests/unit/chat-runtime-event-handlers.test.ts tests/unit/chat-run-lifecycle.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Renderer continues to use the existing chat store/runtime event boundary; no component-level spinner hiding is added.
  - Renderer does not add direct Gateway HTTP calls or direct component IPC calls.
  - A `final` event whose runId matches the foreground `activeRunId` continues through the existing foreground finalization path unchanged.
  - A `final` event whose runId does not match the foreground `activeRunId` continues to be treated as untracked unless it is an `announce:v1:*` delegation announce run for the current foreground session.
  - A bound `announce:v1:*` final must not be stopped by the generic `!matchesCurrentRun` early-return branch before announce-safe settlement has a chance to run.
  - A bound `announce:v1:*` final may clear `sending`, `pendingFinal`, `activeRunId`, visible streaming fields, pending tool images, and execution graph active state only through the existing safe clear/finalization helpers.
  - The announce-safe settlement must verify that the announce run is tied to the current session's completed child delegation before clearing foreground state.
  - The announce-safe settlement must not clear while Gateway/backend activity reports a tracked foreground user run or a processing child session belonging to the current turn.
  - The announce-safe settlement must not surface hidden internal text such as `NO_REPLY`, internal prompts, internal thinking, or tool-only payloads as visible chat messages.
  - An unrelated `announce:v1:*` final from another session, another child session, or an unbound child must refresh history if appropriate but must not clear foreground local run state.
  - Duplicate or replayed announce finals do not duplicate the visible assistant answer and do not reactivate a settled run.
  - Late announce finals after user abort do not re-open `sending`, `pendingFinal`, `activeRunId`, the stop button, or the execution graph.
  - Existing empty-final/stale-session recovery remains responsible when there is no visible assistant answer after the latest user message.
docs:
  required: false
---

## Problem

In the observed production run, the task actually completed:

1. The child session produced a successful final answer and wrote the generated PPT path.
2. The parent transcript received the final assistant wrap-up message.
3. Gateway logged the parent session as `idle` with `reason="run_completed"` and cleared active runs.
4. Renderer still showed the foreground conversation as "thinking".

The stuck state happened because the final event delivered to renderer used an announce runId:

```text
announce:v1:<child-session-key>:<child-run-id>
```

That announce runId differs from the foreground `activeRunId` that was created when the user sent the parent request. The runtime event handler therefore classified the final as not matching the current run, refreshed history, and exited the final handler before the existing announce wrap-up settlement helpers could run.

This is a renderer lifecycle reconciliation bug. It is not a missing transcript write, not a Gateway active-run leak, and not a model intelligence issue.

## Root Cause

The `final` event handler currently has a generic untracked-run guard before announce-specific finalization:

```ts
if (!matchesCurrentRun) {
  clearHistoryPoll();
  void get().loadHistory(true, { force: true }).finally(...);
  break;
}
```

For `announce:v1:*` final events, this guard can be too broad. A valid announce wrap-up final is expected to have a runId different from the foreground `activeRunId`, but it can still be the terminal event that proves the foreground delegated turn is complete.

The code already has announce-aware helpers, such as `trySyncClearAnnounceWrapUp` and `tryFinalizeUserTurnAfterAssistantFinal`, but the early return makes them unreachable for this exact event shape.

## Scope

Allowed changes:

- Adjust final-event ordering so bound `announce:v1:*` finals are evaluated by announce-safe settlement before falling back to generic untracked-run handling.
- Reuse or tighten existing helpers in `finalize-turn-bridge.ts` for binding, visibility, backend-idle, child-idle, and cleared-run checks.
- Keep duplicate logic in `src/stores/chat.ts` and `src/stores/chat/runtime-event-handlers.ts` consistent.
- Add focused unit tests that reproduce the production shape.

Disallowed changes:

- Do not treat every unmatched runId as safe to clear.
- Do not treat every `announce:v1:*` runId as safe to clear.
- Do not clear foreground state from unrelated background sessions.
- Do not bypass `finalize-turn-bridge.ts` with direct ad hoc state patches unless the patch shape is the existing cleared active-run shape.
- Do not solve this in `src/pages/Chat/index.tsx` by hiding indicators while store state remains active.
- Do not change Gateway transport, session spawning, transcript persistence, or provider behavior.

## Required Semantics

The final handler must distinguish these cases:

- Foreground final: `runId` matches the current `activeRunId`; use the existing foreground final path.
- Bound announce final: `runId` is `announce:v1:*`, belongs to a completed child delegation for the current foreground turn, and Gateway/backend activity is idle; run announce-safe settlement and clear local run state if the helper says it is safe.
- Unbound announce final: `runId` is `announce:v1:*` but does not belong to the current foreground turn; do not clear foreground local run state.
- Generic untracked final: `runId` is absent or unrelated; refresh history/polling as before and do not clear foreground local run state.
- Intermediate tool final: a tool-use/tool-result final still requiring another assistant step; do not settle until the concluding assistant response or safe silent completion arrives.
- Empty final without visible answer: keep existing empty-final/stale-session recovery behavior.
- Aborted run late final: ignore for reactivation and do not re-open local active state.

## Safe Announce-Settle Contract

A mismatched `announce:v1:*` final may settle the foreground run only when all required conditions are true:

- The current foreground session key is known.
- The announce runId parses as a delegation announce run.
- The announce child session key is bound to the current foreground turn or matches the recorded spawned child for that turn.
- The child delegation has completed or the announce final is the completion signal for that child.
- Gateway/backend activity no longer reports a tracked foreground user run.
- Gateway/background activity no longer reports the bound child as processing.
- The current turn already has a visible assistant answer, or the announce final itself corresponds to the visible wrap-up answer that has been written to transcript.
- The run was not user-aborted in a way that makes the late announce event stale.

When these conditions are satisfied, use the same clearing shape as the normal finalization path, equivalent to `buildClearedActiveRunPatch()`.

## Non-Goals

- Do not redesign subagent delegation.
- Do not change the child session runtime.
- Do not introduce a new polling transport.
- Do not broaden finalization for all background finals.
- Do not weaken safety checks for unrelated sessions.
- Do not change generated-script loop prevention, tool watchdogs, or stalled-run diagnostics.

## Test Matrix

- Bound announce final with mismatched runId: foreground `activeRunId` is the original parent run, incoming final runId is `announce:v1:*`, child is bound and completed, backend is idle, visible answer exists; `sending`, `pendingFinal`, `activeRunId`, streaming fields, and execution graph active state clear.
- Bound announce final is not swallowed by the generic `!matchesCurrentRun` early return; the announce-safe helper is invoked or its resulting cleared state is observable.
- Unbound announce final from another child/session: history may refresh, but foreground `sending`, `pendingFinal`, and `activeRunId` remain unchanged.
- Generic mismatched non-announce final: existing untracked behavior remains unchanged.
- Foreground matching final: existing finalization behavior remains unchanged.
- Bound announce final while the bound child remains in `processingSessionKeys`: foreground state remains active.
- Bound announce final while backend reports a tracked user run for the foreground session: foreground state remains active.
- Duplicate bound announce final after state is already settled: no duplicate assistant message and no reactivated running state.
- Late bound announce final after user abort: does not reactivate the run or clear a newer run.
- Empty final/no visible answer case: existing empty-final recovery remains responsible.

## Implementation Guidance

Prefer a narrow ordering change in the final-event handler:

1. Detect whether the incoming final is an announce delegation run.
2. Allow bound announce finals to reach the existing announce-safe settlement helpers before the generic unmatched-run early return.
3. Keep generic unmatched finals on the current history-refresh path.

For example, the generic guard should be equivalent to:

```ts
if (!matchesCurrentRun && !isSubagentDelegationAnnounceRun(runId)) {
  clearHistoryPoll();
  void get().loadHistory(true, { force: true }).finally(...);
  break;
}
```

This example is not sufficient by itself unless the subsequent announce path still performs the binding, backend-idle, child-idle, visible-answer, and abort checks described above.

Keep `src/stores/chat.ts` and `src/stores/chat/runtime-event-handlers.ts` behavior in sync so the active runtime path and compatibility path cannot diverge.

## Validation

Run the required unit tests and comms replay/compare checks before implementation review.

If `pnpm harness validate` fails for unrelated local Windows temp-file cleanup issues, record the failure output and still run the focused unit tests that prove the state-machine behavior.
