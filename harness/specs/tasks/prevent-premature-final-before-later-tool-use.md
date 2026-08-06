---
id: prevent-premature-final-before-later-tool-use
title: Prevent a visible interim reply from finalizing before later tool use
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Keep the active chat run open when a visible assistant stop snapshot is followed by a later assistant tool-use message in the same user turn.
touchedAreas:
  - harness/specs/tasks/prevent-premature-final-before-later-tool-use.md
  - src/stores/chat/run-lifecycle.ts
  - tests/unit/chat-run-lifecycle.test.ts
  - tests/unit/user-turn-lifecycle.test.ts
expectedUserBehavior:
  - Tool-round narration cannot appear as a completed final reply while the same run continues invoking tools.
  - A genuine terminal assistant reply after the last tool activity still completes normally, including when Gateway processing metadata is stale.
  - Existing subagent, cumulative-final, delayed-history, duplicate-output, and empty-final recovery behavior remains unchanged.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/prevent-premature-final-before-later-tool-use.md
  - pnpm exec vitest run tests/unit/chat-run-lifecycle.test.ts tests/unit/user-turn-lifecycle.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - A terminal assistant candidate followed by an assistant tool-use message is not considered the committed terminal for the active user turn.
  - canForceClearOnVisibleCommittedReply returns false for the reproduced August 5 sequence while backend processing remains strongly active.
  - A terminal assistant reply that occurs after the final tool-use message remains eligible for stale-backend force-clear recovery.
  - No renderer transport, host-api, Gateway endpoint, or protocol-switching behavior changes.
docs:
  required: false
---

## Scope

The August 5 incident produced a renderer-visible assistant message with `stopReason: stop`, followed by another assistant message with `stopReason: toolUse`. Gateway still reported the current run and session as processing, but the earlier stop message was selected as terminal and triggered `force_clear`.

This task changes only terminal selection for the current user turn. A terminal candidate is valid only when no later assistant tool-use activity exists in that turn. Tool results and a later genuine terminal reply remain valid transcript shapes.
