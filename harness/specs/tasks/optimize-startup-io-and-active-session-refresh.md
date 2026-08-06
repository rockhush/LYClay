---
id: optimize-startup-io-and-active-session-refresh
title: Avoid duplicate startup skill I/O and active-session refresh scans
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Reuse startup Skill metadata and defer session-list scans while the current backend session is active.
touchedAreas:
  - harness/specs/tasks/optimize-startup-io-and-active-session-refresh.md
  - src/lib/skill-update-check.ts
  - src/stores/gateway.ts
  - tests/unit/startup-skill-update-preparation.test.ts
  - tests/unit/gateway-events.test.ts
  - tests/unit/empty-final-recovery.test.ts
  - tests/unit/skills-store-fetch-parallel.test.ts
  - tests/unit/finalize-turn-bridge-announce.test.ts
  - tests/unit/chat-runtime-event-handlers.test.ts
expectedUserBehavior:
  - Startup Skill update detection reuses catalog and install metadata already loaded by the Skill store.
  - Current-session transcript updates do not repeatedly scan all sessions while backend activity is still running.
  - Deferred session refreshes coalesce and run once after the current session becomes idle.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - tests/unit/startup-skill-update-preparation.test.ts
  - tests/unit/gateway-events.test.ts
acceptance:
  - Existing chat finalization, folding, duplicate-output, and cross-turn ownership behavior is unchanged.
  - Renderer communication continues through the existing host API and Gateway store boundaries.
  - Comms replay and compare pass.
docs:
  required: false
---

Performance-only correction for startup Skill metadata preparation and active-session refresh coalescing.
