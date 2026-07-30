---
id: allow-mcp-query-credentials
title: 允许远程 MCP URL 使用查询参数凭据
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 允许用户显式配置的 SSE 与 streamable-http MCP 服务在 URL 查询参数中携带服务端要求的 token、api_key 等凭据，同时继续执行远程域名、协议、私网和 metadata 地址网络策略，并避免把查询参数写入网络安全审计。
touchedAreas:
  - electron/utils/mcp-config-validator.ts
  - electron/security/mcp-server-policy.ts
  - shared/mcp-url-display.ts
  - src/pages/Connectors/CustomMcpConnectorCard.tsx
  - src/pages/Connectors/index.tsx
  - src/pages/Connectors/InstallDialog.tsx
  - tests/unit/mcp-config-validator.test.ts
  - tests/unit/mcp-url-display.test.ts
  - tests/e2e/connectors-page.spec.ts
  - harness/specs/rules/mcp-remote-url-policy.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - 用户可以保存 URL 查询参数中包含 token、api_key 或签名参数的远程 MCP 连接器。
  - 查询参数凭据不会绕过 HTTPS/WSS、域名授权、私网地址和 metadata 地址限制。
  - 普通 Agent、Skill、Host API 或 Gateway 出站请求中的敏感数据仍由全局 network-policy 拒绝。
  - MCP 配置网络审计只记录不含 query 和 fragment 的安全 URL。
  - 连接器卡片和 MCP 授权确认会遮蔽 URL 查询参数值。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/allow-mcp-query-credentials.md
  - pnpm exec vitest run tests/unit/mcp-config-validator.test.ts tests/unit/security-network-policy.test.ts
  - pnpm run test:e2e -- tests/e2e/connectors-page.spec.ts
acceptance:
  - validateMcpConfigNetworkPolicy 在调用统一网络策略前移除远程 MCP URL 的 query 和 fragment。
  - 原始 MCP URL 完整保存在配置中，OpenClaw Runtime 仍能收到服务端要求的查询参数凭据。
  - 未知域名、私网地址、metadata 地址和不安全协议的既有校验保持有效。
  - evaluateNetworkPolicy 对普通出站 URL 中 token 参数的 hard deny 行为保持不变。
  - Electron E2E 覆盖从连接器弹窗保存带 token 查询参数的禁用远程 MCP 配置。
  - 连接器卡片不显示查询参数凭据明文。
docs:
  required: true
---

## Notes

本任务只为用户主动管理的 MCP Server 配置提供窄范围兼容。它不增加全局 secret-scan 绕过参数，不放宽普通网络请求，也不改变 OpenClaw Runtime 的 MCP 鉴权格式。
