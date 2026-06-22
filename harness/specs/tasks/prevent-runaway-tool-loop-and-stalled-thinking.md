---
id: prevent-runaway-tool-loop-and-stalled-thinking
title: Detect runaway tool loops before chat appears stuck
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add run-level observability and convergence guidance for excessive tool calls and document/data workflows so long tasks converge instead of appearing stuck.
touchedAreas:
  - electron/main/ipc-handlers.ts
  - src/stores/chat/types.ts
  - src/stores/chat/runaway-tool-observer.ts
  - src/stores/chat/task-convergence-strategy.ts
  - src/stores/chat/runtime-send-actions.ts
  - src/stores/chat/runtime-event-actions.ts
  - tests/unit/chat-runaway-tool-observer.test.ts
  - tests/unit/chat-runtime-send-actions.test.ts
expectedUserBehavior:
  - Normal general chat behavior remains unchanged.
  - Starting a message records the detected workflow kind, such as spreadsheet, PDF, Word, presentation, data-analysis, batch-files, or general.
  - Document/data tasks receive an internal convergence strategy that asks the agent to inspect structure only briefly, run one complete processing flow, and validate at most 1-2 times.
  - Runtime tool events update a diagnostic snapshot with tool call count, tool result count, write/exec loop indicators, and risk state.
  - When a run becomes tool-heavy or enters a repeated write/exec pattern, the observer prepares a graded convergence directive for downstream recovery/UI work.
  - The observer can distinguish a slow long task from a likely runaway tool/debug loop for later user-facing recovery work.
  - No automatic abort, output compression, or UI pause behavior is introduced in PR2.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/prevent-runaway-tool-loop-and-stalled-thinking.md
  - pnpm exec vitest run tests/unit/chat-runaway-tool-observer.test.ts tests/unit/chat-runtime-send-actions.test.ts
acceptance:
  - Sending a document/data task initializes a per-session observer snapshot before the Gateway RPC returns.
  - When the RPC returns a runId, the observer snapshot is bound to that runId.
  - Spreadsheet, PDF, Word, presentation, data-analysis, and batch-file workflows have specific convergence instructions.
  - Text-only `chat.send` and media-backed `chat:sendWithMedia` both pass the convergence strategy through `extraSystemPrompt`.
  - Tool call and tool result events are de-duplicated and counted without changing the event handling result.
  - Repeated write plus exec debugging patterns are recorded as a debug_loop risk state once the threshold is crossed.
  - Debug-loop and high-tool-count risks prepare light, medium, or force convergence directives without interrupting the current run.
  - High tool-call counts progress through needs_convergence, tool_heavy, must_summarize, and needs_pause diagnostic labels.
  - Observer state is serializable and stored per session so it can be surfaced by later UI or recovery PRs.
  - Renderer code continues to use the existing store and Main-owned transport path; no direct Gateway HTTP or new direct ipcRenderer call is added.
docs:
  required: false
---

## Scope

PR1 is observation-only. It creates the data model needed to explain and later recover from runs that spend a long time in model/tool loops after many tool calls.

PR2 adds convergence strategy injection for document/data tasks and prepares graded convergence directives when the observer detects a risky loop. It still does not stop or pause active runs.

This task intentionally does not:

- stop active runs
- summarize tool output
- change context compression thresholds
- alter Gateway transport behavior
- add user-facing warning UI

## Follow-Up PRs

Later PRs can consume this observer state to implement user-facing long-task hints, automatic loop pause, output summarization, and context performance thresholds.
