---
id: add-mcp-server-permission-grants
title: 增加 MCP Server 独立授权与 stdio 高风险确认
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: MCP Server 新增、配置变化或重新启用时必须经过 Main 进程授权判断；stdio MCP 启动本地进程前要求高风险确认，并支持会话与永久授权、撤销和审计。
touchedAreas:
  - electron/security/types.ts
  - electron/security/mcp-server-policy.ts
  - electron/security/permission-store.ts
  - electron/security/confirmation-service.ts
  - electron/security/audit-log.ts
  - electron/api/routes/mcp.ts
  - electron/api/routes/connectors.ts
  - electron/api/routes/security.ts
  - src/components/security/SecurityConfirmationDialog.tsx
  - src/pages/Settings/SecuritySettings.tsx
expectedUserBehavior:
  - 首次启用 stdio MCP 服务时弹出高风险确认。
  - 首次启用远程 MCP 服务时，在网络策略通过后弹出 MCP 服务确认。
  - 用户可以允许一次、本次启动允许或永久允许。
  - MCP command、args、url、env 或 headers 变化后，旧授权不再匹配。
  - 安全设置页可以查看和撤销 MCP 服务授权。
  - 确认弹窗、设置页和审计日志不展示 env 或 headers 中的凭据明文。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-mcp-server-permission-grants.md
  - pnpm exec vitest run tests/unit/security-permission-store.test.ts tests/unit/security-confirmation-service.test.ts tests/unit/security-confirmation-dialog.test.tsx tests/unit/security-settings-page.test.tsx tests/unit/mcp-server-authorization-routes.test.ts
acceptance:
  - permission store 支持 McpServerGrant 的 session、persistent、find 和 revoke。
  - stdio MCP 风险为 high，远程 MCP 风险为 medium。
  - MCP 配置保存仅对新增或安全配置变化且处于启用状态的服务触发确认。
  - MCP 工具 deny 列表变化不会重复触发 MCP 服务确认。
  - MCP 显式启用和内置 Connector 安装、启用均经过确认服务。
  - Settings 安全授权页面展示 MCP 授权并允许撤销。
  - 用户确认和授权变更进入审计日志。
docs:
  required: false
---

## Notes

本阶段不拦截 OpenClaw Runtime 内部的每一次 MCP 工具调用，也不实现 HTTP/CONNECT egress proxy。工具级运行期策略和强制网络出口属于后续阶段。
