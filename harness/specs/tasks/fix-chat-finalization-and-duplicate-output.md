---
id: fix-chat-finalization-and-duplicate-output
title: Fix chat finalization and duplicate output
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Ensure LYClaw clears a completed chat run when the runtime has produced a final assistant answer, and avoid appending duplicate assistant output when the same final answer is observed more than once.
touchedAreas:
  - src/stores/chat.ts
  - src/stores/chat/run-lifecycle.ts
  - src/stores/chat/runtime-event-handlers.ts
  - src/stores/chat/user-turn-lifecycle.ts
  - src/lib/subagent-delegation.ts
  - tests/unit/chat-runtime-event-handlers.test.ts
  - tests/unit/chat-final-folding-state-machine.test.ts
  - tests/unit/chat-event-dedupe.test.ts
  - tests/unit/subagent-delegation-transcript-settle.test.ts
  - tests/unit/task-visualization.test.ts
  - tests/e2e/chat-task-visualizer.spec.ts
expectedUserBehavior:
  - A normal assistant text final after a user task clears the chat execution state instead of leaving the session stuck as running.
  - Tool-use finals and interim narration before tool execution still keep the run open.
  - Replayed or duplicated final events do not duplicate the visible assistant answer.
  - A cumulative final remains visible while authoritative transcript history is delayed.
  - A terminal answer that discusses Agents or subagent orchestration remains a reply unless it also contains an explicit waiting or in-progress signal.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/fix-chat-finalization-and-duplicate-output.md
  - pnpm exec vitest run tests/unit/chat-event-dedupe.test.ts tests/unit/session-backend-bridge.test.ts
  - pnpm exec vitest run tests/unit/chat-runtime-event-handlers.test.ts tests/unit/chat-final-folding-state-machine.test.ts
  - pnpm exec playwright test tests/e2e/chat-task-visualizer.spec.ts -g "cumulative final"
acceptance:
  - Renderer continues to use existing store and host-api/api-client paths; no direct Gateway HTTP calls or direct component IPC are added.
  - Ambiguous text finals without tool calls may finalize when they are the visible assistant answer for the current turn.
  - Finals that contain tool-use blocks or are clearly tool-round plumbing remain active.
  - Duplicate final answers are detected even when the replayed payload lacks a stable id.
  - Existing empty-final diagnostic and recovery behavior remains intact.
  - The cumulative-final handoff never leaves the renderer with neither a committed reply nor a streaming reply.
  - Subagent waiting notices remain folded, while completed explanatory answers are not classified from subagent terminology alone.
docs:
  required: false
---

## Scope

This task is limited to the renderer chat runtime event state machine and its unit coverage. It must not change Gateway transport policy or add new backend routes.

When Gateway sends a cumulative final assembled from earlier tool-round narration and the final answer, keep that payload as transient streaming state until the authoritative transcript replaces it. Completed tool narration remains in the execution graph, while the final suffix remains in the assistant reply area.
