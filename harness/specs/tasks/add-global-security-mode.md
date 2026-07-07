---
id: add-global-security-mode
title: 添加全局安全模式开关
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为 LYClaw 安全策略增加 Main-owned 全局模式，支持标准、信任和关闭确认三档，同时确保不可恢复破坏、凭据泄露、远程代码执行和边界逃逸等 hard deny 永远保留。
touchedAreas:
  - electron/security/**
  - electron/api/routes/security.ts
  - electron/utils/store.ts
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-mode.test.ts
  - tests/e2e/security-settings.spec.ts
expectedUserBehavior:
  - 标准模式保持现有安全策略、授权和确认弹窗行为。
  - 信任模式自动允许 prompt 决策，deny 决策保持拒绝。
  - 关闭确认模式自动允许 prompt 和普通 deny，只保留 critical 或 hardDeny 的拒绝。
  - Settings > Security 页面可以查看和切换模式；切到关闭确认时需要用户确认一次。
  - 自动放行和保留硬拦截都写入安全审计，包含原始决策、有效决策、安全模式和 hard deny 信息。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-global-security-mode.md
  - pnpm exec vitest run tests/unit/security-mode.test.ts tests/unit/security-policy-engine.test.ts tests/unit/security-confirmation-service.test.ts
acceptance:
  - SecurityMode 类型包含 standard、trusted、off，默认值为 standard，并持久化在 Main settings store。
  - Renderer 只通过 Host API `/api/security/settings` 读写模式，不直接决定安全裁决。
  - policy-engine 和 confirmation-service 均应用统一模式转换，避免不同入口行为不一致。
  - `trusted` 只把 prompt 转成 allow，不放开 deny。
  - `off` 把 prompt 和 normal deny 转成 allow，但 hardDeny 或 critical deny 保持 deny。
  - 命令策略中的 root 删除、远程脚本管道执行、PowerShell policy bypass、危险根权限修改被标记为 hard deny。
  - 文件策略中的敏感路径和 symlink escape 被标记为 hard deny。
  - 网络策略中的危险协议、URL 凭据、凭据外传、localhost/private/link-local 保护被标记为 hard deny。
  - 打开目标中的 javascript/data/vbscript 协议被标记为 hard deny。
  - critical prompt injection deny 被标记为 hard deny。
  - Settings 安全页展示三档模式，并有 E2E 覆盖。
docs:
  required: true
---

## Scope

This task adds the global mode switch only. It does not remove the existing permission grant store, audit log, confirmation dialog, or individual policy evaluators. Raw evaluators should continue to expose the base policy result; runtime assert/confirmation/engine entry points apply the effective mode.
