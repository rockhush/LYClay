---
id: refresh-external-channel-session-updates
title: Refresh external channel session updates
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Refresh LYClaw chat sessions when an external channel such as DingTalk updates local OpenClaw session transcripts outside the foreground renderer send flow.
touchedAreas:
  - electron/main/index.ts
  - electron/preload/index.ts
  - electron/utils/session-transcript-watcher.ts
  - src/lib/host-events.ts
  - src/stores/gateway.ts
  - tests/unit/gateway-events.test.ts
expectedUserBehavior:
  - DingTalk bot messages and replies that are persisted to local OpenClaw session files appear in LYClaw without restarting the app.
  - Newly created external-channel sessions are added to the local session list after the transcript or sessions.json changes.
  - If the updated session is currently open, the chat view refreshes quietly without showing a disruptive loading state.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/refresh-external-channel-session-updates.md
  - pnpm exec vitest run tests/unit/gateway-events.test.ts tests/unit/host-events.test.ts
acceptance:
  - Renderer continues to use host events and store actions instead of direct Gateway HTTP calls.
  - No direct window.electron.ipcRenderer.invoke calls are added to pages/components.
  - Main-process file watching coalesces noisy transcript writes before notifying the renderer.
docs:
  required: false
---
