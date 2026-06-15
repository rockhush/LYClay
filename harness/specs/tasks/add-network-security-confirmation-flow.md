---
id: add-network-security-confirmation-flow
title: 添加网络访问安全确认弹窗
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 当网络策略返回需要确认时，通过 Main 进程发起安全确认请求，Renderer 展示确认弹窗，用户选择后由 Main 继续请求或写入 domain grant。
touchedAreas:
  - electron/security/**
  - electron/main/ipc-handlers.ts
  - electron/preload/index.ts
  - src/App.tsx
  - src/components/security/**
  - tests/unit/security-confirmation-service.test.ts
  - tests/unit/security-confirmation-dialog.test.tsx
  - tests/unit/security-network-preflight.test.ts
expectedUserBehavior:
  - 未授权公网 URL 不再直接显示技术错误，而是弹出网络访问确认框。
  - 用户可以选择拒绝、允许一次、本会话允许或永久允许。
  - 允许一次只放行当前请求，不写入授权记录。
  - 本会话允许会写入 session domain grant。
  - 永久允许会写入 persistent domain grant，并可在 Settings > Security 中看到。
  - 私网、localhost 非授权端口和危险协议仍然直接拒绝，不弹确认。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-network-security-confirmation-flow.md
  - pnpm exec vitest run tests/unit/security-confirmation-service.test.ts tests/unit/security-confirmation-dialog.test.tsx tests/unit/security-network-preflight.test.ts tests/unit/security-network-policy.test.ts
acceptance:
  - Main 进程拥有 confirmation service，并负责最终写入授权。
  - Renderer 只能返回用户选择，不能直接决定授权状态。
  - chat.send 显式 URL 会触发确认流。
  - allow-once、allow-session、allow-persistent 和 deny 都有单元测试覆盖。
  - 确认弹窗显示域名、来源、风险和原因。
docs:
  required: false
---

## Notes

本阶段只处理显式 URL 访问确认。页面跳转、二级资源请求、Browser runtime 内部联网仍需后续 HTTP/CONNECT 代理阶段解决。
