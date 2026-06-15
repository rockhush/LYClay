---
id: add-file-path-security-policy
title: Add first-stage file path security policy
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Add a Main-process file path security policy that blocks sensitive paths and unauthorized roots before renderer, Host API, or session file operations touch disk.
touchedAreas:
  - electron/security/**
  - electron/main/ipc-handlers.ts
  - electron/api/routes/files.ts
  - tests/unit/security-path-policy.test.ts
expectedUserBehavior:
  - Files and folders selected through native dialogs continue to work for attachment staging and workspace browsing.
  - Arbitrary renderer or Host API path requests outside authorized workspaces/session grants are denied before disk access.
  - Sensitive paths such as SSH keys, cloud credentials, environment files, browser credential stores, and Windows account hives are blocked even if their parent directory is otherwise authorized.
  - Session deletion can only rename transcript files under the expected OpenClaw agent sessions directory.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-file-path-security-policy.md
  - pnpm exec vitest run tests/unit/security-path-policy.test.ts
acceptance:
  - File read/stage/thumbnail/open-path routes call the centralized path policy before using caller-provided paths.
  - Native dialog selections create only session-scoped path grants.
  - Delete and execute capabilities are not automatically allowed by the first-stage path policy.
  - No direct Gateway HTTP calls or new renderer direct IPC paths are introduced.
docs:
  required: false
---

## Goal

Add a Main-process file path security policy for LYClaw file capabilities.

## Scope

- Add a centralized path policy for path normalization, sensitive-path blocking, symlink escape detection, and capability checks.
- Add a session-scoped permission store for paths selected through native dialogs.
- Apply the policy to file read/stage/thumbnail/open-path/session-delete surfaces.
- Keep command, network, MCP, Skill prompt-injection, OS sandbox, and UI permission management out of scope.

## Validation

- No renderer page/component may add direct `window.electron.ipcRenderer.invoke(...)` calls beyond existing allowed usage.
- Host API file staging and IPC file routes must reject sensitive paths and paths outside authorized roots.
- Session deletion must only rename files under the expected OpenClaw agent sessions directory.

## Commands

- pnpm exec vitest run tests/unit/security-path-policy.test.ts
- pnpm harness validate --spec harness/specs/tasks/add-file-path-security-policy.md
