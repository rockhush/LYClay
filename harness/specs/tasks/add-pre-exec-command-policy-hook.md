---
id: add-pre-exec-command-policy-hook
title: Add pre-exec command policy hook
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Move LYClaw command policy decisions before OpenClaw exec approval creation.
touchedAreas:
  - electron/api/routes/security.ts
  - electron/gateway/**
  - electron/utils/openclaw-auth.ts
  - electron/security/**
expectedUserBehavior:
  - Low-risk exec commands run without OpenClaw exec approval follow-up runs.
  - Commands requiring confirmation still show the LYClaw security confirmation dialog.
  - Rejected commands are reported as blocked tool calls without executing.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/openclaw-auth.test.ts
  - tests/unit/security-routes.test.ts
acceptance:
  - Renderer does not call Gateway HTTP directly.
  - OpenClaw exec approvals are no longer forced for every exec command.
  - The Main-owned command policy remains the source of truth for runtime exec decisions.
  - Comms replay and compare pass.
docs:
  required: false
---

Install a LYClaw-owned OpenClaw before_tool_call hook that preflights exec commands through the Host API security route before OpenClaw's exec approval machinery runs.
