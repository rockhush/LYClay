---
id: install-marketplace-digital-employee
title: Install marketplace digital employee
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Install a marketplace digital employee package as a local employee instance, create its exclusive OpenClaw Agent, copy portable Agent workspace files, and preserve packaged Skills and private MCP configuration with rollback on failure.
touchedAreas:
  - shared/types/digital-employee.ts
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
  - tsconfig.node.json
  - src/types/digital-employee.ts
  - src/stores/digital-employees.ts
  - src/stores/agents.ts
  - electron/api/server.ts
  - electron/api/routes/digital-employees.ts
  - electron/services/digital-employee-installer.ts
  - electron/services/digital-employee-updater.ts
  - electron/utils/digital-employee-package.ts
  - electron/utils/digital-employee-storage.ts
  - electron/utils/agent-config.ts
  - electron/utils/local-skill-upload.ts
  - electron/utils/paths.ts
  - tests/unit/digital-employee-package.test.ts
  - tests/unit/digital-employee-storage.test.ts
  - tests/unit/digital-employee-installer.test.ts
  - tests/unit/digital-employee-updater.test.ts
  - tests/unit/digital-employee-routes.test.ts
  - tests/unit/digital-employees-store.test.ts
  - tests/e2e/fixtures/electron.ts
  - tests/e2e/digital-employee-install.spec.ts
expectedUserBehavior:
  - Clicking Use passes the marketplace list item id to the Host API, which downloads the package from https://ai.lingyiitech.com/management/agents/download/{id}/ and installs a local employee instance.
  - Marketplace cards show an installation progress state and refresh their installed status from local employee records after installation.
  - Installation creates one exclusive local OpenClaw Agent and copies the package Agent workspace descriptions into that Agent workspace.
  - Packaged Skills remain under the installed employee directory for later employee-scoped runtime loading.
  - Packaged MCP configuration remains inside the installed employee directory and is not registered in global openclaw.json during installation.
  - Failed installation rolls back resources created by that installation and does not remove pre-existing Agents.
  - Packages with allowMultipleInstances set to false reject a second local installation before creating an Agent.
  - Installed employees appear in the local employee list and expose the bound Agent session key.
  - Updating an employee preserves instanceId, agentId, sessionKey, USER.md, sessions, memory, credentials, and user data.
  - Updating replaces the package, packaged Skills, workflows, resources, and managed Agent workspace files; managed files removed from the new package are removed locally.
  - An update failure restores the previous package, managed workspace files, and Agent definition.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm exec vitest run tests/unit/digital-employee-package.test.ts tests/unit/digital-employee-storage.test.ts tests/unit/digital-employee-installer.test.ts tests/unit/digital-employee-updater.test.ts tests/unit/digital-employee-routes.test.ts tests/unit/digital-employees-store.test.ts
  - pnpm run typecheck
acceptance:
  - Renderer installation calls use src/lib/host-api.ts and do not access the filesystem, Gateway HTTP, or Electron IPC directly.
  - Renderer installation requests provide only the marketplace employee id; renderer-controlled package URLs are not accepted.
  - The fixed ai.lingyiitech.com marketplace download host may resolve to a company-private address; private redirects to any other host remain blocked.
  - Package downloads are limited to 512 MiB and extracted package content is limited to 1 GiB.
  - The package is fully validated before Agent creation or Agent configuration mutation.
  - Local employee state is stored under ~/.openclaw/digital-employees without SQLite.
  - instanceId and agentId include the package slug plus a short locally generated suffix so operators can identify installed employees.
  - Agent template display name and model are applied, while id and managed paths remain locally controlled.
  - instanceId and agentId are generated locally and never trusted from the marketplace package.
  - Agent runtime credentials, models, sessions, memory, and absolute publisher paths are never imported from the package.
  - install.json records the Agent binding and installation status; installation creates no global MCP runtime entries.
  - Employee Skills are preserved in the employee installation directory and are not copied into the global managed Skills directory by this task.
  - MCP configuration is validated as package content and copied unchanged under the employee installation directory.
  - Rollback removes only resources explicitly created by the failed installation.
  - Concurrent installation requests cannot bypass the single-instance package check.
  - Updates require the same packageId and a strictly newer semantic version.
  - USER.md is never overwritten or deleted by an update.
  - Updating an employee replaces its packaged MCP configuration together with the rest of the employee package and does not mutate global MCP configuration.
docs:
  required: true
---
