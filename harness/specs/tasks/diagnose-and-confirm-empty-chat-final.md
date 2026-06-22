---
id: diagnose-and-confirm-empty-chat-final
title: Diagnose and confirm empty chat finals before surfacing completion
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add diagnostics and renderer confirmation for user chat runs that receive a final event without a message so empty finals do not silently look like successful completions.
touchedAreas:
  - electron/gateway/manager.ts
  - src/stores/chat/runtime-event-handlers.ts
  - tests/unit/chat-event-dedupe.test.ts
  - tests/unit/gateway-empty-final-diagnostics.test.ts
expectedUserBehavior:
  - Normal final assistant messages still complete the run immediately.
  - Background session finalization behavior remains unchanged.
  - A foreground empty final first reloads history to surface any transcript-backed assistant output.
  - If no assistant output appears after a short retry window, the current run ends with a visible run error instead of silently disappearing.
  - Main process logs include session file and lock diagnostics when a user chat run completes with an empty final.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/diagnose-and-confirm-empty-chat-final.md
  - pnpm exec vitest run tests/unit/chat-event-dedupe.test.ts tests/unit/gateway-empty-final-diagnostics.test.ts
acceptance:
  - Empty final diagnostics include runId, sessionKey, timing, tracked runs, session file stats, and lock recovery results.
  - Empty finals with transcript-backed assistant output are treated as successful completion after history reload.
  - Empty finals with no new assistant output after retry surface a runError and clear active run state.
  - Existing tool-only final and background final behavior is preserved.
docs:
  required: false
---
