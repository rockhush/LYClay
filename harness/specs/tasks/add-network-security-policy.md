---
id: add-network-security-policy
title: 添加网络访问安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在 Main 进程中增加网络访问安全策略，在网络请求发出前限制协议、域名、localhost 端口和私网地址，阻断 SSRF、本地服务探测和带凭据 URL 等高风险访问。
touchedAreas:
  - electron/security/**
  - electron/main/ipc/host-api-proxy.ts
  - electron/main/ipc-handlers.ts
  - tests/unit/security-network-policy.test.ts
expectedUserBehavior:
  - 允许访问明确白名单内的公网 HTTPS 域名。
  - 未知公网域名会被标记为需要用户确认，而不是默认静默外联。
  - file、data、javascript 等非 HTTP(S) 协议会被阻断。
  - localhost 只能访问明确允许的 LYClaw/Gateway 端口，其他本地端口会被阻断。
  - 私网地址、link-local 地址和云 metadata 地址会被阻断，降低 SSRF 风险。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-network-security-policy.md
  - pnpm exec vitest run tests/unit/security-network-policy.test.ts
acceptance:
  - 网络策略提供可复用的 evaluate/assert API，供 Main 进程内的网络入口调用。
  - 策略结果会返回 allow、deny 或 prompt，并包含风险等级、原因、命中的规则和稳定的拒绝代码。
  - 域名白名单支持子域名匹配。
  - localhost 访问必须匹配显式 allowLocalhostPorts。
  - Renderer 到 Host API 和 Gateway HTTP 的 Main 进程代理入口会经过网络策略检查。
docs:
  required: false
---

## Notes

本阶段先实现字面 URL、协议、域名和私网地址判断，不做 DNS 解析后的私网检测。DNS 解析、网络确认 UI 和域名授权持久化可以作为后续阶段继续接入。
