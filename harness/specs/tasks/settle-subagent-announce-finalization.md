---
id: settle-subagent-announce-finalization
title: Safely settle completed chat turns after final events
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Fix chat turns that remain visibly "thinking" after the runtime has produced a final answer and Gateway has no live work, without weakening tool-round, subagent, empty-final, abort, or background-session behavior.
touchedAreas:
  - harness/specs/tasks/settle-subagent-announce-finalization.md
  - src/stores/chat/runtime-event-handlers.ts
  - src/stores/chat/finalize-turn-bridge.ts
  - src/stores/chat/user-turn-lifecycle.ts
  - src/stores/chat/run-lifecycle.ts
  - src/lib/delegation-turn-state.ts
  - src/lib/subagent-delegation.ts
  - src/lib/subagent-delegation-watch.ts
  - tests/unit/chat-event-dedupe.test.ts
  - tests/unit/user-turn-lifecycle.test.ts
  - tests/unit/chat-run-lifecycle.test.ts
expectedUserBehavior:
  - When a user-visible assistant answer has been produced for the latest user turn and Gateway confirms no live parent or child work remains, the chat leaves the thinking/executing state.
  - The stop button, composer disabled state, sidebar running indicator, and execution graph active state settle together from the shared chat lifecycle state.
  - Internal completion prompts, internal thinking, internal tool calls, and assistant `NO_REPLY` finals remain hidden from the visible chat and execution graph.
  - A visible answer generated before an internal silent final remains in history and is not removed, duplicated, replaced, or followed by a generic timeout banner.
  - Long-running child delegation still keeps the parent turn active while Gateway reports that child session as processing.
  - Genuine empty-final cases with no visible assistant answer still use the existing empty-final and stale-session recovery flow.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/settle-subagent-announce-finalization.md
  - pnpm exec vitest run tests/unit/chat-event-dedupe.test.ts tests/unit/user-turn-lifecycle.test.ts tests/unit/chat-run-lifecycle.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Renderer continues to use the existing chat store, host-api, and api-client boundaries; no direct Gateway HTTP calls and no direct component IPC calls are added.
  - The fix is implemented in the chat lifecycle/finalization helpers, not by hiding thinking indicators in `src/pages/Chat/index.tsx`.
  - A normal assistant text final for the foreground `activeRunId` may clear `sending`, `pendingFinal`, `activeRunId`, visible streaming fields, pending tool images, and stale execution graph activity only after backend activity confirms no tracked user run for the current session.
  - An `announce:v1:*` final whose runId differs from the foreground `activeRunId` may settle the foreground turn only when it is tied to a completed child delegation for the current session.
  - Foreground settle is blocked while Gateway reports a tracked user run for the current session or a processing child session that belongs to the current turn.
  - Transcript-only delegation markers are not a permanent blocker once Gateway is idle and the current turn already has a visible assistant answer; they may defer briefly through the existing grace path but must not keep the UI stuck forever.
  - Tool-use/tool-result intermediate finals still keep the turn active when another model step or assistant text response is required.
  - A silent final such as `NO_REPLY` may close local waiting state only when the current user turn already has a prior visible assistant answer or the parent delegation wrap-up is otherwise proven complete.
  - A silent final must not be treated as success when there is no visible assistant answer after the latest user message; the existing empty-final/stale-session recovery remains responsible.
  - Duplicate or replayed final/announce events do not duplicate visible assistant output and do not re-open a settled run.
  - Late events for an aborted run do not reactivate `sending`, `pendingFinal`, `activeRunId`, the stop button, or the execution graph.
  - Background-session finalization does not clear the foreground session unless the event is explicitly tied to the foreground turn by the existing delegation binding rules.
  - Existing normal text final, tool-use final, tool-timeout, user abort, background-session finalization, and empty-final diagnostic behavior remains unchanged outside the safe-settle condition.
docs:
  required: false
---

## Problem

A chat run can complete successfully while the UI remains in the current-turn executing state.

The representative production log sequence is:

1. `chat.send` is accepted for the foreground session and returns a runId.
2. The runtime streams visible assistant text for that run.
3. Gateway emits `state=final` for the same runId.
4. Gateway records `perf:chat-run run.completed`.
5. Session lock recovery/audit reports the run as terminal, with no remaining lock.
6. Repeated history reads show the transcript file size and message count no longer changing.
7. Renderer still has local active-run state (`sending`, `pendingFinal`, or `activeRunId`), so the UI keeps showing "thinking".

This is a renderer lifecycle reconciliation bug. It is not a provider outage, not a missing transcript write, and not evidence that Gateway is still executing the run.

## Root Cause

The foreground assistant-final path intentionally performs a two-phase settle:

1. append or preserve the final assistant message,
2. keep local run signals active (`sending`, `pendingFinal`, `activeRunId`) until `tryFinalizeUserTurnAfterAssistantFinal` reconciles backend activity and transcript state.

That second phase is too conservative. If backend/delegation state is stale or transcript-only delegation markers still look open, the helper can keep local run signals active even though Gateway has already emitted `final` and no live work remains.

The fix must make the "safe to settle current user turn" decision explicit and shared, instead of relying on scattered checks in the event handler, history loader, sidebar, and chat UI.

## Scope

This task is limited to renderer chat lifecycle reconciliation for completed foreground turns and subagent announce/final wrap-up.

Allowed changes:

- Add or tighten helper functions that classify safe terminal assistant output, silent finals, active backend work, and active child delegation.
- Adjust `tryFinalizeUserTurnAfterAssistantFinal`, announce wrap-up handling, and derived executing-state helpers to use the same safe-settle contract.
- Add focused unit tests for the safe-settle and no-regression scenarios.

Disallowed changes:

- Do not change Gateway transport policy, startup, WS/HTTP/IPC fallback, or backend routes.
- Do not add direct renderer calls to Gateway HTTP endpoints or direct component IPC calls.
- Do not paper over the issue by hiding spinners or stop buttons in `src/pages/Chat/index.tsx` while store state remains active.
- Do not treat every final event, every assistant message, or every `announce:v1:*` runId as sufficient to settle.

## Safe-Settle Contract

A foreground user turn is safe to settle only when all required conditions are true:

- The event/session matches the current foreground session, or an announce event is tied to a completed child delegation for that foreground session.
- The latest user turn has a visible assistant answer, or a silent/internal final is closing a turn that already had such an answer.
- The candidate terminal message is not a tool-use/tool-result intermediate state that requires another model step.
- Backend activity for the current session has no tracked user run.
- Gateway background activity has no processing child session belonging to the current turn.
- The run has not been user-aborted in a way that should ignore late events.

When these conditions are met, the implementation must use the existing cleared-run shape, equivalent to `buildClearedActiveRunPatch()`, so all derived UI surfaces settle consistently.

## Strong vs Weak Signals

Strong blockers:

- `sessionBackendActivity.hasTrackedUserRun` for the current session.
- A Gateway `processingSessionKeys` entry that belongs to a child delegation for the current turn.
- A tool-use/tool-result final that is known to be an intermediate tool round.
- A user abort marker that makes the incoming event stale.

Weak signals:

- Transcript-only delegation markers after Gateway is idle.
- Stale local `sending`, `pendingFinal`, or `activeRunId`.
- History polling that sees assistant activity but no longer sees transcript growth.
- Old execution graph steps from a prior active state.

Weak signals may delay settlement through an existing grace/confirmation path, but they must not permanently block settlement when the safe-settle contract is satisfied.

## Required Semantics

The implementation must distinguish these states:

- Active backend work: Gateway or backend still tracks parent work or a child session for the current turn.
- Active tool round: the final event represents tool activity and another assistant response is still expected.
- Completed turn with visible answer: final assistant output exists for the latest user turn and Gateway is idle.
- Silent/internal completion: `NO_REPLY` or equivalent confirms no additional user-facing output is needed after a visible answer already exists.
- Empty final without answer: no visible assistant output exists after the latest user message, so recovery/diagnostics must decide what to do.

Only "completed turn with visible answer" and valid "silent/internal completion" may settle the visible chat run.

## Non-Goals

- Do not surface `NO_REPLY` as a chat message.
- Do not show internal completion prompts, internal thinking, or internal tool calls in the chat or execution graph.
- Do not weaken empty-final diagnostics for unanswered turns.
- Do not clear a turn solely because the runId starts with `announce:v1`.
- Do not clear while a child delegation for the current turn is still processing.
- Do not change comms transport policy or backend process lifecycle.
- Do not refactor unrelated UI, provider, build, or packaging code.

## Test Matrix

- Foreground normal text final: `sending=true`, `activeRunId` matches, visible assistant final arrives, backend idle, no processing child; UI state clears.
- Production stuck-thinking shape: visible assistant answer already exists after the latest user message, final/run.completed has arrived, backend idle, transcript stops changing; stale local `pendingFinal` does not keep the UI active.
- Parent spawns child: child completion announce final arrives, child is bound to the current foreground turn, visible answer exists, Gateway child processing is idle; UI state clears.
- Parent spawns child, but another bound child remains in `processingSessionKeys`; UI remains active and no timeout banner is shown.
- `announce:v1:*` final with unrelated or unbound child session; foreground state is not cleared.
- Internal `NO_REPLY` after visible answer; `NO_REPLY` stays hidden and the already-settled run remains settled.
- Internal `NO_REPLY` after the latest user message with no visible assistant answer; existing empty-final/stale-session recovery remains responsible.
- Tool-use/tool-result intermediate final; `pendingFinal` may remain active and the run is not settled until the concluding assistant response arrives.
- Duplicate final or duplicate announce final after settlement; no duplicate assistant message and no reactivated active-run state.
- User abort followed by late delta/final; the aborted run stays cleared and does not restart thinking.
- Background session receives final while foreground session is open; foreground session is not cleared unless an explicit completed-child binding allows it.
- Existing tool timeout, provider error, security denial, and context overflow errors still clear or surface errors exactly as before.

## Implementation Guidance

Prefer a small explicit helper, for example `canSettleCurrentUserTurn(...)`, over spreading ad hoc checks through event handlers and components.

The helper should receive enough state to be deterministic:

- current session key,
- latest user timestamp,
- visible messages,
- backend activity for the session,
- Gateway background activity,
- runId,
- optional terminal message,
- optional announce/delegation metadata.

It should return a boolean and, if useful for tests/diagnostics, a structured reason such as `safe-visible-final`, `safe-silent-after-answer`, `blocked-backend-active`, `blocked-child-processing`, `blocked-tool-round`, or `blocked-unanswered-silent-final`.

Use the helper from the finalization bridge first. Derive UI state (`isExecuting`, sidebar running indicator, stop button state, execution graph activity) from the settled store state rather than duplicating finalization decisions in components.

## Validation

Run the required unit tests and comms replay/compare checks before implementation review.

If an Electron E2E is added or updated, keep it focused on the user-visible behavior: send/spawn/yield completion, final answer remains visible, thinking indicator and stop button settle, execution graph is no longer active, and no timeout banner appears.
