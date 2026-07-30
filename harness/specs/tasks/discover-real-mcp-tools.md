---
id: discover-real-mcp-tools
title: 展示每个连接器真实 MCP 工具
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 修复连接器工具发现把 Gateway 全局工具目录错误归属给每个 MCP Server 的问题；优先读取 Gateway 按服务器分组或命名空间工具，无法明确归属时使用官方 MCP SDK 直接连接远程 SSE/streamable-http 服务并调用 tools/list。
touchedAreas:
  - package.json
  - pnpm-lock.yaml
  - electron/utils/mcp-gateway-tools.ts
  - electron/api/routes/mcp.ts
  - src/stores/connectors.ts
  - src/pages/Connectors/CustomMcpConnectorCard.tsx
  - src/i18n/locales/en/connectors.json
  - src/i18n/locales/zh/connectors.json
  - src/i18n/locales/ja/connectors.json
  - src/i18n/locales/ru/connectors.json
  - tests/unit/mcp-gateway-tools.test.ts
  - tests/unit/mcp-server-authorization-routes.test.ts
  - tests/e2e/connectors-page.spec.ts
  - harness/specs/rules/mcp-tool-discovery-policy.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - 不同 MCP 连接器只显示各自声明的工具，不再重复显示 OpenClaw 全局工具。
  - mysql-server 能显示其 tools/list 返回的 check_connection、list_connections、get_databases、get_tables、get_schema 和 query。
  - Gateway 提供明确的按服务器目录时优先使用该目录，避免重复直连。
  - 工具发现失败时页面显示失败状态，不再把全局工具或空结果冒充成功。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/discover-real-mcp-tools.md
  - pnpm exec vitest run tests/unit/mcp-gateway-tools.test.ts tests/unit/mcp-server-authorization-routes.test.ts
  - pnpm run test:e2e -- tests/e2e/connectors-page.spec.ts
acceptance:
  - 删除工具总数小于等于 96 时返回全部 Gateway 工具的兜底。
  - 只有按 server bucket 或 serverName 前缀明确匹配的 Gateway 工具才能归属到该连接器。
  - SSE 与 streamable-http 直接发现使用官方 MCP Client 和对应 transport，并透传连接器 headers。
  - 直接发现支持 tools/list 分页、超时和 finally close。
  - API 返回 discoverySource 与 discoveryError，UI 区分加载、成功为空和发现失败。
  - Electron E2E 不再展示无归属的 27 个全局工具。
docs:
  required: true
---

## Notes

stdio MCP 不由页面直接拉起进程；若 Gateway 无法提供其按服务器工具目录，则显示工具发现不可用。直接远程发现前继续执行现有 MCP 配置网络策略。
