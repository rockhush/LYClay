---
id: fix-electron-shell-snapshot
title: 修复 Electron shell 环境快照启动方式
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 修复 OpenClaw Gateway 在 Electron runtime 中捕获 shell 环境时把内联 Node 脚本误当成应用路径的问题，同时保留 shell 环境快照能力。
touchedAreas:
  - harness/specs/tasks/fix-electron-shell-snapshot.md
  - scripts/openclaw-shell-snapshot-patches.mjs
  - scripts/patch-openclaw-dev.mjs
  - scripts/bundle-openclaw.mjs
  - tests/unit/openclaw-shell-snapshot-patches.test.ts
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm exec vitest run tests/unit/openclaw-shell-snapshot-patches.test.ts
  - SKIP_PREINSTALLED_SKILLS=1 pnpm run package
  - pnpm run comms:replay
  - pnpm run comms:compare
expectedUserBehavior:
  - macOS 或 Linux 上执行 Agent 命令时，shell 环境快照可以正常创建和刷新。
  - 环境快照采集不会启动第二个 LYClaw 实例，也不会弹出 Electron Error launching app 对话框。
  - Agent 命令仍能继承安全的 PATH 和工具链环境变量。
acceptance:
  - shell snapshot 保持启用，不设置 OPENCLAW_EXEC_SHELL_SNAPSHOT=0。
  - Electron runtime 仅在固定环境提取命令上设置 ELECTRON_RUN_AS_NODE=1。
  - Gateway forkEnv 和其他子进程不继承本修复引入的 ELECTRON_RUN_AS_NODE。
  - 普通 Node runtime 继续直接使用 process.execPath 执行环境提取脚本。
  - Windows 现有 shell snapshot 跳过分支保持不变。
  - 开发预启动和打包流程复用同一个补丁模块。
  - 找不到 shell snapshot bundle 或补丁无法验证时，开发预启动和打包明确失败。
  - 补丁重复执行保持幂等，OpenClaw 上游等价修复可以通过 verifier。
docs:
  required: false
---

## Notes

本任务只修复 OpenClaw shell snapshot 内部环境提取脚本的 Electron/Node 启动边界。不改变快照缓存、变量白名单、敏感信息过滤、Agent exec 安全策略、renderer/Main 通信协议或用户设置。
