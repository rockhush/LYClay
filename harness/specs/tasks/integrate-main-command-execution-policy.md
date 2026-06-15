---
id: integrate-main-command-execution-policy
title: 接入 Main 进程命令执行入口安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 Main 进程中已有的本地命令执行入口接入命令安全策略和确认服务，避免后台修复、诊断命令绕过统一安全边界。
touchedAreas:
  - electron/gateway/supervisor.ts
  - electron/utils/channel-config.ts
  - electron/security/**
  - tests/unit/gateway-supervisor.test.ts
  - tests/unit/channel-config.test.ts
expectedUserBehavior:
  - Gateway 自动修复需要执行 OpenClaw Doctor Fix 时，必须先经过命令安全确认。
  - 用户拒绝或没有可用确认窗口时，不启动修复进程，Gateway 启动流程返回明确失败。
  - 频道配置诊断命令必须经过命令策略检查。
  - 低风险诊断命令继续自动放行。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-main-command-execution-policy.md
  - pnpm exec vitest run tests/unit/gateway-supervisor.test.ts tests/unit/channel-config.test.ts tests/unit/security-confirmation-service.test.ts tests/unit/security-command-policy.test.ts
acceptance:
  - Gateway doctor repair 调用 assertCommandAllowedWithConfirmation 后才启动 utilityProcess.fork。
  - 命令确认拒绝时 Gateway doctor repair 不启动子进程。
  - channel-config 的 doctor 校验在 child_process.exec 前执行命令策略检查。
  - 相关行为有单元测试覆盖。
docs:
  required: false
---

## Notes

本阶段优先接入高风险和明确的 Main 命令入口。进程清理、安装器、DWS/Gemini 登录、Skill 安装脚本和包管理器入口将在后续阶段继续收敛到统一策略。
