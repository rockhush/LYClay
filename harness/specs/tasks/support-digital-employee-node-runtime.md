---
id: support-digital-employee-node-runtime
title: Support platform-managed Node runtime for digital employee MCP servers
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: Let digital employee packages declare Node-based MCP servers portably without requiring end users to install Node.js globally or package a Node runtime per employee.
touchedAreas:
  - shared/types/digital-employee.ts
  - electron/utils/mcp-json.ts
  - electron/utils/mcp-config-validator.ts
  - electron/utils/bundled-node.ts
  - scripts/download-bundled-node.mjs
  - package.json
  - electron/utils/digital-employee-mcp.ts
  - electron/utils/digital-employee-package.ts
  - electron/services/digital-employee-installer.ts
  - electron/services/digital-employee-updater.ts
  - patches/openclaw@2026.6.5.patch
  - patches/openclaw@2026.5.19.patch
  - artifacts/digital-employee-dqe/dqe-quality-specialist/mcp/servers.template.json
  - tests/unit/digital-employee-mcp.test.ts
  - tests/unit/digital-employee-package.test.ts
  - tests/unit/openclaw-digital-employee-isolation.test.ts
  - tests/unit/bundled-node.test.ts
expectedUserBehavior:
  - A digital employee package can declare a stdio MCP server with runtime: node and entry: mcp/server.mjs instead of a machine-specific command path.
  - Installing or updating the package writes employee-local runtime MCP config that launches with the ClawX-managed Node executable and an absolute employee-local entry path.
  - Users without a globally installed Node.js can run Node-based digital employee MCP servers when the ClawX bundled Node runtime is present.
  - Digital employee MCP servers remain hidden from the connectors UI and auto-enabled only for the owning employee runtime.
  - If the bundled Node runtime is unavailable, the runtime falls back to a safe current Node process when possible and otherwise reports a clear MCP configuration error.
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm exec vitest run tests/unit/digital-employee-mcp.test.ts tests/unit/digital-employee-package.test.ts tests/unit/openclaw-digital-employee-isolation.test.ts tests/unit/bundled-node.test.ts
  - pnpm run typecheck
acceptance:
  - Package validation accepts portable Node runtime declarations with runtime: node and a portable relative entry path.
  - Package validation rejects runtime declarations with absolute, empty, or package-escaping entry paths.
  - Runtime MCP config generation converts runtime: node + entry to command + args and removes package-only runtime/entry fields before writing OpenClaw-consumable config.
  - Runtime MCP config generation resolves command to the ClawX bundled Node executable when it exists, before falling back to process.execPath or PATH Node.
  - Mac packaging scripts download darwin-x64 and darwin-arm64 Node runtimes so packaged ClawX exposes process.resourcesPath/bin/node.
  - Runtime MCP config generation sets cwd to the employee install directory when no cwd/workingDirectory is supplied.
  - Runtime MCP config generation injects CLAWX_NODE and EMPLOYEE_DIR into env for employee MCP servers.
  - DQE servers.template.json uses runtime: node and entry: mcp/dqe-report-server.mjs, not C:\\Program Files\\nodejs\\node.exe.
  - OpenClaw digital employee isolation runtime can still build employee-local MCP servers from employee package config.
  - Renderer code is not involved; no direct Gateway HTTP or filesystem access is added to renderer paths.
docs:
  required: false
---
