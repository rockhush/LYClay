---
id: improve-chat-runtime-visibility
title: Improve chat runtime visibility before first stream delta
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Surface locally persisted intermediate chat runtime steps while waiting for Gateway stream deltas, and add timing logs that identify whether latency is in send acceptance, transcript progress, stream delivery, or final completion.
touchedAreas:
  - src/stores/chat.ts
  - src/stores/chat/chat-run-perf.ts
  - tests/unit/chat-store-history-retry.test.ts
  - tests/e2e/chat-first-response-progress.spec.ts
expectedUserBehavior:
  - After sending a chat message, the user's optimistic message remains visible immediately.
  - If no stream delta arrives quickly but OpenClaw has written intermediate thinking/tool messages to the transcript, the chat UI refreshes from the local transcript and shows that progress.
  - The fallback stops once stream data or a terminal event arrives and does not duplicate user messages.
  - A final assistant report after tool use stops the thinking state once the transcript records a terminal stop reason.
  - Transcript progress without an explicit stop reason cannot end a run, while final events carrying tool calls remain active.
  - Text-only assistant deltas render progressively in the reply bubble instead of being hidden by an empty execution graph.
  - The chat viewport follows `streamingMessage` deltas so growing process and final-response text remains visible before finalization.
  - Current-session events carrying sequence numbers pass through one dedupe check, allowing each new cumulative delta to update the visible reply.
  - Console logs expose a timeline covering send start, RPC acceptance, local transcript progress, first runtime event/delta, and completion.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/improve-chat-runtime-visibility.md
  - pnpm exec vitest run tests/unit/chat-store-history-retry.test.ts tests/unit/chat-event-dedupe.test.ts
  - pnpm exec playwright test tests/e2e/chat-first-response-progress.spec.ts
acceptance:
  - Renderer continues to use host-api/api-client/Gateway store boundaries.
  - Renderer does not call Gateway HTTP endpoints directly.
  - No direct window.electron.ipcRenderer.invoke calls are added to pages/components.
  - Comms replay and compare remain applicable for final validation.
docs:
  required: false
---
