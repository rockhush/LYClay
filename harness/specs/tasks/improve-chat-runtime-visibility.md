---
id: improve-chat-runtime-visibility
title: Improve chat runtime visibility before first stream delta
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Surface locally persisted intermediate chat runtime steps while waiting for Gateway stream deltas, and add timing logs that identify whether latency is in send acceptance, transcript progress, stream delivery, or final completion.
touchedAreas:
  - src/stores/chat.ts
  - src/stores/chat/user-turn-lifecycle.ts
  - src/stores/chat/session-backend-bridge.ts
  - src/stores/chat/runtime-event-handlers.ts
  - electron/gateway/manager.ts
  - electron/api/routes/gateway.ts
  - electron/api/routes/sessions.ts
  - src/lib/host-api.ts
  - src/pages/Chat/index.tsx
  - src/components/layout/Sidebar.tsx
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/zh/chat.json
  - src/stores/chat/chat-run-perf.ts
  - src/stores/chat/runtime-send-actions.ts
  - src/stores/chat/helpers.ts
  - tests/unit/chat-store-history-retry.test.ts
  - tests/unit/user-turn-lifecycle.test.ts
  - tests/e2e/chat-first-response-progress.spec.ts
expectedUserBehavior:
  - After sending a chat message, the user's optimistic message remains visible immediately.
  - If no stream delta arrives quickly but OpenClaw has written intermediate thinking/tool messages to the transcript, the chat UI refreshes from the local transcript and shows that progress.
  - The fallback stops once stream data or a terminal event arrives and does not duplicate user messages.
  - A final assistant report after tool use stops the thinking state once the transcript records a terminal stop reason.
  - Transcript progress without an explicit stop reason cannot end a run, while final events carrying tool calls remain active.
  - Text-only assistant deltas render progressively in the reply bubble instead of being hidden by an empty execution graph.
  - When the gateway still reports processing or a tracked user run, empty-final recovery must keep sending/activeRunId instead of clearing the run anchor.
  - loadHistory history-final must not clear an open turn while backend session activity is still processing.
  - checkStuck timeouts must consult backend session activity before aborting long multi-tool runs.
  - sendMessage must abort an existing tracked backend run before starting a new one.
  - Stale sessions.json status alone (for example a completed session still marked processing) must not keep the current session stuck in executing; disk status requires a live Gateway run, lock, or recent transcript activity.
  - While a spawned subagent has not posted its completion event, the parent session must stay in running state (sidebar, stop button, execution graph) even if the parent Gateway run is idle.
  - The chat viewport follows `streamingMessage` deltas so growing process and final-response text remains visible before finalization.
  - Current-session events carrying sequence numbers pass through one dedupe check, allowing each new cumulative delta to update the visible reply.
  - Console logs expose a timeline covering send start, RPC acceptance, local transcript progress, first runtime event/delta, and completion.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/improve-chat-runtime-visibility.md
  - pnpm exec vitest run tests/unit/chat-store-history-retry.test.ts tests/unit/chat-event-dedupe.test.ts tests/unit/user-turn-lifecycle.test.ts tests/unit/chat-run-lifecycle.test.ts
  - pnpm exec playwright test tests/e2e/chat-first-response-progress.spec.ts
acceptance:
  - Renderer continues to use host-api/api-client/Gateway store boundaries.
  - Renderer does not call Gateway HTTP endpoints directly.
  - No direct window.electron.ipcRenderer.invoke calls are added to pages/components.
  - Comms replay and compare remain applicable for final validation.
docs:
  required: false
---
