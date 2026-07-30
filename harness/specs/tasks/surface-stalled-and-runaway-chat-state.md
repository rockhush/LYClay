---
id: surface-stalled-and-runaway-chat-state
title: Surface stalled and runaway chat runs without false finalization
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Surface Gateway stalled-session diagnostics and runaway tool-loop risk in Chat so users can stop or retry a genuinely active but unhealthy run, without clearing active run state or changing normal long-running task behavior.
touchedAreas:
  - electron/gateway/manager.ts
  - electron/utils/gateway-health.ts
  - src/types/gateway.ts
  - src/stores/gateway.ts
  - src/stores/chat/types.ts
  - src/stores/chat/runaway-tool-observer.ts
  - src/pages/Chat/index.tsx
  - src/i18n/locales/en
  - src/i18n/locales/zh
  - src/i18n/locales/ja
  - tests/unit/gateway-manager-diagnostics.test.ts
  - tests/unit/gateway-health.test.ts
  - tests/unit/chat-first-response-preparing.test.ts
  - tests/unit/chat-runaway-tool-observer.test.ts
expectedUserBehavior:
  - Normal slow model responses and normal long tool runs continue to show the existing active thinking/execution state.
  - When Gateway reports the current chat session as `classification=stalled_agent_run`, Chat replaces the generic thinking/waiting copy with a stalled-run warning that says the runtime is still active but has not made useful progress recently.
  - The stalled warning keeps the stop button available and does not make the composer look idle.
  - When runaway observer state reaches `debug_loop`, `tool_heavy`, `must_summarize`, or `needs_pause`, Chat explains that the run may be stuck in repeated tool/debug work and suggests stopping, retrying with a smaller task, or waiting.
  - Stalled/runaway warnings are scoped to the current session only; switching to another session must not show another session's warning.
  - If the run later streams useful assistant text, tool progress, final, error, or abort events, the warning updates or clears according to the existing active-run lifecycle.
  - Empty-final recovery and subagent announce-finalization behavior remain unchanged.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/surface-stalled-and-runaway-chat-state.md
  - pnpm exec vitest run tests/unit/gateway-manager-diagnostics.test.ts tests/unit/gateway-health.test.ts tests/unit/chat-first-response-preparing.test.ts tests/unit/chat-runaway-tool-observer.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Gateway stuck-session parsing preserves structured fields from stderr, including `classification`, `reason`, `activeWorkKind`, `lastProgress`, `lastProgressAgeSeconds`, `recovery`, `sessionKey`, `sessionId`, `state`, `ageSeconds`, `queueDepth`, and `raw`.
  - Gateway health/status exposes the most recent stuck-session diagnostic without dropping existing heartbeat/RPC health fields.
  - Renderer obtains stuck-run diagnostics through existing host-api/api-client/store paths only; no direct `window.electron.ipcRenderer.invoke(...)` or direct Gateway HTTP fetch is added in Chat.
  - Chat only treats a stuck diagnostic as relevant when its `sessionKey` matches `currentSessionKey` and its `classification` is `stalled_agent_run`.
  - Relevant stalled diagnostics do not set `sending=false`, do not clear `activeRunId`, do not clear `pendingFinal`, and do not synthesize a final assistant message.
  - Relevant stalled diagnostics do not suppress incoming stream deltas, tool events, final events, error events, or user abort events for the same run.
  - Runaway tool-loop UI consumes the existing `RunawayToolObservation` snapshot and does not mutate observer counters from React render code.
  - Runaway risk states below `debug_loop` keep the existing UI unchanged unless a separate stalled Gateway diagnostic is also relevant.
  - User abort from the stop button still clears active UI state through the existing abort flow and does not leave the stalled warning stuck on screen.
  - Background-session stuck diagnostics are available in Gateway diagnostics but are not shown as the current Chat warning unless the user switches to that session.
  - Empty-final diagnostics continue to decide unanswered empty final recovery; stalled/runaway UI must not mark an unanswered empty final as completed.
  - The implementation includes unit coverage for current-session stalled warning, other-session diagnostic suppression, normal slow-run non-warning, runaway debug-loop warning, and abort cleanup.
  - No automatic abort, automatic retry, automatic output summarization, context compression threshold change, provider timeout change, or transport policy change is introduced by this task.
docs:
  required: false
---

## Problem

A chat run can remain genuinely active while making little useful progress. In the observed failure mode, the agent repeatedly wrote and executed generated Python scripts, hit encoding or syntax errors, asked the model how to recover, and then repeated similar tool work. Gateway correctly reported active backend work and later classified the session as `stalled_agent_run`, but Chat still looked like an ordinary "thinking" state.

This is different from stale finalization bugs where the backend already ended and the renderer failed to clear local state. A stalled active run must stay active in the UI, but it needs a clearer status and a safe user action.

## Non-Goals

- Do not reuse this task to change `shouldReconcileVisibleFinal` or any final-message reconciliation behavior.
- Do not clear `sending`, `activeRunId`, or `pendingFinal` just because a run is stalled.
- Do not mark a stalled run as completed.
- Do not automatically abort active runs.
- Do not automatically retry the user request.
- Do not summarize tool output or alter context compression behavior.
- Do not change model/provider timeout values.
- Do not add renderer-side Gateway transport switching, direct Gateway HTTP calls, or direct IPC calls.

## State Model

Use three separate concepts:

- `completed`: terminal runtime state received through existing final/error/abort lifecycle.
- `active`: backend or renderer still has an active run, active tool, pending final, or stream state.
- `unhealthyActive`: the run is active but diagnostics indicate stalled backend work or likely runaway tool/debug looping.

`unhealthyActive` is a display and guidance state only. It must never imply `completed`.

## Stalled Diagnostic Rules

A Gateway stuck-session diagnostic is relevant to the current Chat view only when:

- `diagnostic.sessionKey === currentSessionKey`
- `diagnostic.classification === 'stalled_agent_run'`
- the current Chat state is still executing, such as `sending`, `pendingFinal`, `activeRunId`, or active execution graph state

When relevant, Chat may show a warning such as:

- "Run may be stalled"
- "The runtime is still active, but no useful progress has been seen recently."
- "You can stop this run, retry with a smaller task, or keep waiting."

The warning should include the most helpful available detail, for example `activeWorkKind=model_call` or `reason=active_work_without_progress`, but it must not expose noisy raw logs as the primary text.

## Runaway Tool-Loop Rules

Use `RunawayToolObservation.riskState` as the source of truth for repeated tool/debug work. The warning threshold is:

- no warning for `normal`
- no user-facing warning for `needs_convergence` by default
- show user-facing warning for `debug_loop`, `tool_heavy`, `must_summarize`, and `needs_pause`

The UI must prefer specific wording when possible:

- `debug_loop`: repeated tool/debug attempts detected
- `tool_heavy`: unusually many tool calls detected
- `must_summarize`: run has produced enough tool output that summarization or task narrowing may be needed
- `needs_pause`: run should be paused or stopped before more work continues

This task only surfaces the risk. It does not implement automatic pause.

## UX Boundary

The composer remains in stop mode while the run is active. The primary available action is still the existing stop/abort flow.

The warning must not introduce a new send path, hidden retry, or direct Gateway command. Retry, if implemented later, must be a separate task with explicit state and tests.

## Validation Notes

Use existing fast unit tests for parsing and UI state. Because this touches runtime communication state, run the comms replay/compare checks before implementation review.
