---
id: add-command-security-policy
title: 添加命令执行安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在 Main 进程中增加命令执行安全策略，在本地命令真正执行前完成风险分类，阻断明显危险命令，对高风险命令标记为需要用户确认，并复用文件路径策略检查 cwd 和命令读取的文件路径。
touchedAreas:
  - electron/security/**
  - electron/utils/openclaw-doctor.ts
  - tests/unit/security-command-policy.test.ts
expectedUserBehavior:
  - 授权 workspace 内的只读低风险命令可以继续执行，不增加额外打扰。
  - 安装依赖、修复命令、递归删除、网络访问命令、权限修改命令会被分类为需要用户确认。
  - 删除磁盘根目录、远程脚本下载后直接执行、PowerShell 策略绕过等命令会被直接阻断。
  - 通过命令读取敏感文件时，会和直接文件访问一样被路径安全策略拒绝。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-command-security-policy.md
  - pnpm exec vitest run tests/unit/security-command-policy.test.ts tests/unit/openclaw-doctor.test.ts
acceptance:
  - 命令策略提供可复用的 evaluate/assert API，供 Main 进程内的命令执行入口调用。
  - 组合 shell 命令会被拆分，并且每个片段都会被单独分类。
  - 策略结果会返回 allow、deny 或 prompt，并包含风险等级、原因、命中的规则和稳定的拒绝代码。
  - 除非调用方明确标记为可信系统命令，否则 cwd 必须通过文件路径策略校验。
  - OpenClaw Doctor 执行会经过命令策略检查，其中 Doctor Fix 被视为用户明确确认过的修复命令。
docs:
  required: false
---

## Notes

本阶段只在策略层返回 prompt 决策，不直接实现最终的用户确认 UI。后续做确认弹窗时，可以直接消费同一个命令策略决策对象。
