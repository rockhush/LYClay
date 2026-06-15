---
id: integrate-network-preflight-and-redirect-policy
title: 接入网络 preflight 与 redirect 二次校验
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 让 Main 侧 hostapi/gateway HTTP 代理请求在发出前经过 network-policy，并在 HTTP redirect 后对跳转目标重新执行网络策略，防止已授权入口跳转到未知域名、私网或 metadata 地址。
touchedAreas:
  - electron/security/network-fetch.ts
  - electron/main/ipc/host-api-proxy.ts
  - electron/main/ipc-handlers.ts
  - tests/unit/security-network-fetch.test.ts
expectedUserBehavior:
  - Renderer 通过 hostapi/gateway 代理访问本地服务时仍然正常工作。
  - 如果代理响应跳转到同一已允许本地端口，继续允许。
  - 如果代理响应跳转到已允许的公共域名，继续允许。
  - 如果代理响应跳转到未知公共域名、私网地址或 metadata 地址，请求被阻断。
  - redirect 决策会进入安全审计日志。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-network-preflight-and-redirect-policy.md
  - pnpm exec vitest run tests/unit/security-network-fetch.test.ts
acceptance:
  - 新增安全 fetch 包装，默认使用手动 redirect，不允许底层 fetch 自动无审计跟随跳转。
  - hostapi:fetch 使用安全 fetch 包装，并保留 Host API token 注入和 JSON/text 响应处理。
  - gateway:httpProxy 使用安全 fetch 包装，并保留 Gateway token 注入、RPC chat.send 文本 URL preflight 和超时处理。
  - 每个 redirect Location 会解析成绝对 URL 后重新经过 network-policy。
  - redirect 到未知域名产生 prompt 决策并阻断，redirect 到私网/metadata 产生 deny 决策并阻断。
docs:
  required: false
---

## Notes

Renderer Host API requests that are low-risk allows for the explicitly
allowlisted localhost port are intentionally omitted from the audit log.
Redirect decisions and requests from all other sources remain audited.

本阶段不实现本地 HTTP/CONNECT egress proxy、DNS rebinding 防护、WebSocket/MCP SSE 代理，也不批量改 OAuth、更新器、上报等旧网络入口。那些入口在后续网络专项阶段继续收口。
