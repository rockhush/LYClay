---
id: surface-stuck-chat-session
title: Surface stuck chat session diagnostics
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Detect Gateway/OpenClaw stuck-session diagnostics during long chat waits and surface the real condition instead of a generic model-waiting state.
touchedAreas:
  - electron/gateway/manager.ts
  - electron/gateway/startup-stderr.ts
  - electron/utils/gateway-health.ts
  - src/stores/gateway.ts
  - src/pages/Chat/index.tsx
expectedUserBehavior:
  - When OpenClaw reports a stuck chat session, the chat waiting state explains that the runtime session is stalled or queued.
  - Gateway health diagnostics include the stuck-session reason and most recent stuck-session metadata.
  - Normal slow model responses continue to stream through the existing Gateway event path.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm exec vitest run tests/unit/gateway-manager-diagnostics.test.ts tests/unit/chat-first-response-preparing.test.ts
acceptance:
  - Renderer does not call Gateway HTTP endpoints directly.
  - Renderer continues to use host-api/api-client boundaries.
  - Stuck-session stderr lines update diagnostics without disrupting normal chat deltas.
docs:
  required: false
---
