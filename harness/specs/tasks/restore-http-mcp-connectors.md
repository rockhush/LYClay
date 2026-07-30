---
id: restore-http-mcp-connectors
title: 恢复远程 MCP 连接器 HTTP 支持
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 修复远程 SSE 与 streamable-http MCP 被结构校验错误限制为 HTTPS/WSS 的回退，恢复 http/https/ws/wss URL 支持，并确保所有协议继续经过统一网络策略、域名或私网授权及安全审计。
touchedAreas:
  - electron/utils/mcp-config-validator.ts
  - tests/unit/mcp-config-validator.test.ts
  - tests/e2e/connectors-page.spec.ts
  - src/i18n/locales/en/connectors.json
  - src/i18n/locales/zh/connectors.json
  - src/i18n/locales/ja/connectors.json
  - src/i18n/locales/ru/connectors.json
  - harness/specs/rules/mcp-remote-url-policy.md
  - README.md
  - README.zh-CN.md
  - README.ja-JP.md
expectedUserBehavior:
  - 自定义 SSE 与 streamable-http 连接器可以填写 http:// URL。
  - 自定义连接器表单使用中性的服务地址标签，不再误写为 HTTPS 地址。
  - HTTP URL 不会跳过 network-policy；未知公网目标、私网目标和非默认端口仍按既有策略处理。
  - 已明确授权的 RFC1918 私网 HTTP MCP 可以通过配置预检。
  - link-local、metadata、未授权 localhost 端口和 URL 内嵌用户名密码继续被拒绝。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/restore-http-mcp-connectors.md
  - pnpm exec vitest run tests/unit/mcp-config-validator.test.ts tests/unit/security-network-policy.test.ts
  - pnpm run test:e2e -- tests/e2e/connectors-page.spec.ts
acceptance:
  - MCP URL 结构校验接受 http、https、ws 与 wss，拒绝其他协议。
  - validateMcpConfigNetworkPolicy 对四种远程协议都调用统一网络策略。
  - 已授权私网 IP 的 HTTP MCP 校验通过并产生不含 query/fragment 的网络审计。
  - 未授权私网 IP 与 metadata 地址仍被拒绝。
  - Electron E2E 覆盖从自定义连接器弹窗保存 HTTP SSE 配置。
docs:
  required: true
---

## Notes

本任务恢复的是用户主动配置的远程 MCP 协议兼容性，不为 HTTP 提供全局静默放行，也不改变 network-policy 的授权优先级或 metadata hard deny。
