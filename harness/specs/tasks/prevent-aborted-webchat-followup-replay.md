---
id: prevent-aborted-webchat-followup-replay
title: Prevent aborted webchat follow-up replay
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Ensure an acknowledged webchat request that is aborted before or while entering the follow-up queue cannot execute after a newer turn completes, and keep same-text media re-sends distinct from the aborted text-only turn.
touchedAreas:
  - harness/specs/tasks/prevent-aborted-webchat-followup-replay.md
  - patches/openclaw@2026.6.5.patch
  - pnpm-lock.yaml
  - scripts/openclaw-queued-followup-abort-patches.mjs
  - scripts/patch-openclaw-dev.mjs
  - scripts/bundle-openclaw.mjs
  - src/stores/chat.ts
  - src/stores/chat/helpers.ts
  - tests/unit/openclaw-queued-followup-abort-patches.test.ts
  - tests/unit/chat-optimistic-match.test.ts
expectedUserBehavior:
  - Stopping a just-sent text-only turn prevents that turn from running later, even if its asynchronous dispatch reaches the follow-up queue after the abort.
  - Re-sending the same text with an image starts one new turn and produces one answer; completion does not start a third run for the aborted request.
  - The image-bearing user message remains a distinct turn and is not merged into the earlier text-only message.
  - Ordinary text echoes, attachment echoes, queued channel messages, and existing final-state behavior remain unchanged.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-queued-followup-abort-patches.test.ts tests/unit/chat-optimistic-match.test.ts
  - pnpm exec vitest run tests/unit/chat-abort-run.test.ts tests/unit/chat-event-dedupe.test.ts tests/unit/chat-run-lifecycle.test.ts tests/unit/user-turn-lifecycle.test.ts tests/unit/chat-final-folding-state-machine.test.ts tests/unit/chat-runtime-event-handlers.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - OpenClaw follow-up construction retains the request AbortSignal for internal webchat prompts as well as existing room events.
  - The queue's existing aborted-item checks reject a webchat request aborted before enqueue and suppress one aborted while waiting.
  - Non-webchat channel follow-up behavior is not broadened or cleared session-wide.
  - Same text with different attachment presence is not treated as an optimistic/history echo.
  - A Gateway media marker matching the optimistic attachment path is still treated as the same user send.
  - Existing delayed-final, cumulative-final, empty-final, subagent, and execution-graph state-machine regressions remain green.
docs:
  required: false
---

## Scope

This task changes the patched OpenClaw webchat follow-up abort propagation and the renderer's optimistic user-message reconciliation. It does not change Gateway transport order, add routes, clear all queued work on session abort, or modify final-message classification.
