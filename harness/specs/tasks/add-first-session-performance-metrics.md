---
id: add-first-session-performance-metrics
title: Add first-session chat performance metrics
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Instrument and de-risk the first chat session path so startup, send, first event, and completion latency can be measured without premature UI timeout.
touchedAreas:
  - src/stores/chat/runtime-send-actions.ts
  - src/stores/chat/runtime-event-handlers.ts
  - src/stores/chat/first-session-perf.ts
  - src/stores/gateway.ts
  - src/stores/agents.ts
  - src/stores/chat/session-actions.ts
  - src/components/layout/Sidebar.tsx
  - electron/gateway/manager.ts
expectedUserBehavior:
  - First chat sends continue through the existing host API and Gateway RPC path.
  - Console and main-process logs expose timing for the first session without changing chat behavior.
  - Slow first-token responses are not misreported as provider failure at 90 seconds.
  - Startup cron repair does not immediately compete with first chat startup work.
  - Sidebar startup hydration does not duplicate current chat history loading.
  - Session list loading does not bulk-read every session transcript for labels during startup.
  - Agent snapshot fetching is deduplicated when multiple mounted views request it.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm run typecheck
acceptance:
  - Renderer does not add direct Gateway HTTP calls.
  - Renderer does not bypass the existing IPC/host API boundary.
  - First-session metric logs include send start, chat.send RPC duration, first runtime event, first delta, and final/error duration.
docs:
  required: false
---
