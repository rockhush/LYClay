---
id: implement-dingtalk-shared-bot-user-bindings
title: Implement DingTalk shared bot user bindings
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add user-scoped DingTalk official bot bindings so one managed DingTalk app can welcome and route multiple logged-in users without overwriting personal bots or sharing session context.
touchedAreas:
  - electron/api/routes/dingtalk.ts
  - electron/utils/dingtalk-auto-provision.ts
  - electron/utils/dingtalk-user-bindings.ts
  - electron/utils/channel-config.ts
  - src/lib/host-api.ts
  - d:\lycode\lyclaw-dingtalk-bff\app\main.py
expectedUserBehavior:
  - DingTalk OAuth login provisions a stable official DingTalk account instead of creating duplicate official accounts per user.
  - Each DingTalk user gets a persistent user binding and deterministic session key.
  - Existing user-owned DingTalk bot accounts remain intact when the official bot is added.
  - BFF welcome requests carry account, binding, and session metadata for traceability.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm run typecheck
  - pnpm run lint:check
acceptance:
  - Renderer does not add direct Gateway HTTP calls.
  - Renderer does not bypass the existing host API boundary.
  - Shared official DingTalk credentials are stored once under a stable account id.
  - User binding data is keyed by DingTalk userId and does not overwrite personal accounts.
  - Welcome delivery remains a Main-owned backend call.
docs:
  required: true
---
