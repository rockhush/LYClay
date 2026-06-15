---
id: add-security-permission-store
title: Add security permission store for file grants
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Upgrade the first-stage in-memory path grant helper into a reusable permission store with session and persistent grants, revocation, expiry pruning, and path-policy integration.
touchedAreas:
  - electron/security/**
  - tests/unit/security-permission-store.test.ts
  - tests/unit/security-path-policy.test.ts
expectedUserBehavior:
  - Files and folders selected through native dialogs continue to receive session-scoped access grants.
  - Persisted security grants can survive process-level cache resets and still authorize matching paths.
  - Revoked or expired grants no longer authorize path access.
  - Sensitive files remain blocked even when a broader directory grant exists.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-permission-store.md
  - pnpm exec vitest run tests/unit/security-path-policy.test.ts tests/unit/security-permission-store.test.ts
acceptance:
  - The permission store separates session and persistent grants.
  - Persistent grants are saved in a dedicated security permissions JSON file under app userData unless overridden in tests.
  - Path policy checks the permission store asynchronously before built-in workspace roots.
  - Permission revocation and expiry pruning are covered by unit tests.
docs:
  required: false
---

## Notes

This stage intentionally does not add a Security settings UI. User-facing grant confirmation and revocation controls are deferred to the later UI stage.
