---
id: integrate-gateway-output-redaction
title: 接入 Gateway stdout stderr 脱敏
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在 Gateway 子进程 stdout、stderr、spawn error 进入 LYClaw manager、诊断缓存和日志前统一脱敏，并为 Doctor 输出增加同样的入口保护。
touchedAreas:
  - electron/gateway/process-launcher.ts
  - electron/gateway/startup-stderr.ts
  - electron/gateway/supervisor.ts
  - electron/security/secret-scanner.ts
  - tests/unit/gateway-process-launcher-redaction.test.ts
  - tests/unit/gateway-supervisor.test.ts
expectedUserBehavior:
  - Gateway 正常启动、停止、自动恢复和 Doctor 修复行为保持不变。
  - Gateway stdout、stderr 或启动错误中出现 token、API key、URL 凭据时，LYClaw 内存缓存、错误链路和日志只接收脱敏内容。
  - OpenClaw 自身直接写入的原始日志文件不在本阶段改写；诊断接口读取这些文件时仍会脱敏。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-gateway-output-redaction.md
  - pnpm exec vitest run tests/unit/gateway-process-launcher-redaction.test.ts tests/unit/gateway-supervisor.test.ts tests/unit/logger-redaction.test.ts tests/unit/diagnostics-routes.test.ts
acceptance:
  - process-launcher 在 stdout、stderr 回调和 spawn error 进入后续链路前调用统一 redactor。
  - startup-stderr 写缓存时再次调用统一 redactor。
  - Gateway Doctor stdout、stderr 进入 logger 前调用统一 redactor。
  - 单元测试验证回调和错误对象中不包含 secret 原文。
docs:
  required: false
---

## Notes

本阶段收口 LYClaw 可控的 Gateway 输出链路。OpenClaw 自身直接写入 ~/.openclaw/logs 的原始文件仍属于后续原始日志治理范围，因此表格中的 Gateway stdout/stderr 脱敏应标记为“部分实现”。
