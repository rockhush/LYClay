---
id: add-command-security-confirmation-flow
title: 添加命令执行安全确认弹窗
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 当命令策略返回需要确认时，通过 Main 进程发起安全确认请求，Renderer 展示确认弹窗，用户选择后由 Main 决定是否继续执行命令。
touchedAreas:
  - electron/security/**
  - electron/utils/openclaw-doctor.ts
  - src/components/security/**
  - tests/unit/security-confirmation-service.test.ts
  - tests/unit/security-confirmation-dialog.test.tsx
  - tests/unit/openclaw-doctor.test.ts
expectedUserBehavior:
  - 低风险命令继续自动放行。
  - OpenClaw Doctor Fix 等修复类命令会弹出命令确认框。
  - 用户可以选择拒绝、允许一次或本次启动允许。
  - 允许一次只放行当前命令，不记住选择。
  - 本次启动允许只对相同命令、相同目录和相同来源生效。
  - 禁止级命令仍然直接拒绝，不弹确认。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-command-security-confirmation-flow.md
  - pnpm exec vitest run tests/unit/security-confirmation-service.test.ts tests/unit/security-confirmation-dialog.test.tsx tests/unit/openclaw-doctor.test.ts tests/unit/security-command-policy.test.ts
acceptance:
  - confirmation service 支持 command 类型确认。
  - 命令确认授权状态由 Main 进程保存，Renderer 只能返回用户选择。
  - OpenClaw Doctor Fix 不再通过 confirmed 标记绕过命令确认。
  - 命令确认弹窗显示命令、目录、来源、风险和原因。
  - allow-once、allow-session 和 deny 都有单元测试覆盖。
docs:
  required: false
---

## Notes

本阶段先接入已有的 OpenClaw Doctor/Fix 命令入口。Gateway command tool、Skill 安装脚本、包管理器安装入口和系统 shell IPC 在后续阶段继续接入统一命令确认能力。
