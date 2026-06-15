---
id: integrate-mcp-websocket-network-policy
title: 接入 WebSocket 与 MCP remote 网络策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 扩展 network-policy 覆盖 ws/wss，并在 MCP 配置保存/验证时对 remote MCP URL 执行网络策略，防止远程 MCP、SSE 或 streamable-http 连接绕过域名授权、私网阻断和审计。
touchedAreas:
  - electron/security/network-policy.ts
  - electron/utils/mcp-config-validator.ts
  - electron/api/routes/mcp.ts
  - tests/unit/security-network-policy.test.ts
  - tests/unit/mcp-config-validator.test.ts
expectedUserBehavior:
  - wss:// URL 会按普通外联域名策略判断。
  - ws:// URL 会因未加密 WebSocket 被标记为需要确认。
  - 保存或验证 MCP remote 配置时，未知域名会返回可读错误，不会静默保存成可用配置。
  - MCP remote 指向私网、localhost 未授权端口或 metadata 地址时会被拒绝。
  - MCP remote 网络决策会进入安全审计日志。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-mcp-websocket-network-policy.md
  - pnpm exec vitest run tests/unit/security-network-policy.test.ts tests/unit/mcp-config-validator.test.ts
acceptance:
  - network-policy 支持 ws/wss 协议解析和默认端口判断。
  - wss URL 继续执行 allowlist、domain grant、private address、localhost port 等既有网络规则。
  - ws URL 不被静默 allow，即使命中公开域名，也至少要求确认。
  - validateMcpConfig 保持同步结构校验，新增异步网络校验函数用于 Host API 保存/验证流程。
  - /api/mcp/config PUT 与 /api/mcp/config/validate 会执行 MCP remote URL 网络 preflight。
docs:
  required: false
---

## Notes

本阶段不实现本地 HTTP/CONNECT egress proxy、DNS rebinding 防护、stdio MCP 高风险确认、MCP tool allow/deny 运行期拦截，也不接入完整 MCP server 独立授权 UI。
