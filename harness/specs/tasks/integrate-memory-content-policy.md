---
id: integrate-memory-content-policy
title: 接入 Memory 内容安全策略与可控 RPC 出口治理
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在 LYClaw Main 可控范围内，为 Memory 内容提供写入前检查契约、模型上下文不可信包装，以及 Memory RPC 返回 Renderer 前的递归脱敏、Prompt Injection 扫描、关键内容隐藏和审计。
touchedAreas:
  - electron/security/memory-content-policy.ts
  - electron/security/index.ts
  - electron/gateway/manager.ts
  - electron/main/ipc-handlers.ts
  - tests/unit/security-memory-content-policy.test.ts
expectedUserBehavior:
  - 普通 Memory Doctor 页面和诊断能力保持可用。
  - Memory RPC 返回值中的 API Key、Token 等敏感信息在返回 Renderer 前会被脱敏。
  - Memory RPC 返回值中命中关键 Prompt Injection 规则的文本不会原样返回 Renderer。
  - WS RPC 与 HTTP fallback 使用一致的 Memory 出口净化策略。
  - OpenClaw Runtime 内部直接写入的原始 Memory 文件不会在本阶段改写。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-memory-content-policy.md
  - pnpm exec vitest run tests/unit/security-memory-content-policy.test.ts tests/unit/security-prompt-injection-policy.test.ts tests/unit/security-external-content-policy.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - memory-content-policy.ts 提供 Memory 写入前检查、模型上下文包装和 RPC 出口保护函数。
  - Memory RPC 出口递归处理字符串、数组和对象。
  - 关键 Prompt Injection 内容替换为安全占位符，Secret 在出口脱敏。
  - 每次 Memory RPC 出口治理写入一条基础审计记录，不记录原始 Memory 正文。
  - GatewayManager.rpc 与 gateway:httpProxy HTTP fallback 均接入相同保护函数。
docs:
  required: true
---

## Notes

本阶段只治理 LYClaw Main 可控的 Memory RPC 出口，并为未来 Runtime bridge 固化写入前检查和模型上下文包装契约。OpenClaw Runtime 内部直接管理的 Memory 原始持久化链路尚未经过 LYClaw Main，因此表格中的 Memory 扫描与 Transcript / Memory 脱敏仍应标记为“部分实现”。
