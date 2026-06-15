---
id: integrate-model-secret-preflight
title: 接入发送模型前 Secret 检测与确认
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在用户消息通过 chat.send 发往 Gateway 和模型前扫描疑似 secret，命中时展示脱敏确认弹窗，由用户决定拒绝、允许一次或本次启动允许。
touchedAreas:
  - electron/security/model-secret-preflight.ts
  - electron/security/secret-scanner.ts
  - electron/security/confirmation-service.ts
  - electron/security/audit-log.ts
  - electron/security/types.ts
  - electron/main/ipc-handlers.ts
  - electron/api/routes/gateway.ts
  - src/components/security/SecurityConfirmationDialog.tsx
  - tests/unit/security-model-secret-preflight.test.ts
  - tests/unit/security-confirmation-dialog.test.tsx
  - tests/e2e/security-model-secret-confirmation.spec.ts
expectedUserBehavior:
  - 普通聊天消息继续直接发送。
  - 消息中出现 token、API key、JWT、SSH private key 等疑似 secret 时，发送前弹出安全确认。
  - 弹窗只显示脱敏摘要和 secret 类型，不展示 secret 原文。
  - 用户拒绝后消息不会发送给 Gateway 或模型。
  - 用户选择允许一次后只放行当前请求；选择本次启动允许后，相同消息在本次应用启动内可继续发送。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-model-secret-preflight.md
  - pnpm exec vitest run tests/unit/security-model-secret-preflight.test.ts tests/unit/security-confirmation-dialog.test.tsx tests/unit/security-secret-scanner.test.ts
  - pnpm run test:e2e -- tests/e2e/security-model-secret-confirmation.spec.ts
acceptance:
  - 新增 model-secret-preflight.ts，并接入 chat.send 和 send-with-media 的 Main 进程入口。
  - secret 命中确认请求不包含 secret 原文。
  - secret 命中和用户确认结果写入审计日志。
  - model-secret 确认不提供永久授权。
  - 内部 Gateway warmup 和应用内部命令不受影响。
docs:
  required: false
---

## Notes

本阶段只扫描即将发送给模型的文本消息。附件内容扫描、Transcript、Memory、知识库和上传文档扫描留在后续阶段。
