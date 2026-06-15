---
id: integrate-secret-redactor-logging
title: 接入 Secret Redactor 到运行日志链路
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将统一 secret redactor 接入 LYClaw 普通运行日志、日志 tail 读取和诊断接口，避免 token、API key、URL 凭据等敏感信息写入或展示到日志中。
touchedAreas:
  - electron/security/secret-scanner.ts
  - electron/utils/logger.ts
  - electron/api/routes/diagnostics.ts
  - tests/unit/logger-redaction.test.ts
  - tests/unit/diagnostics-routes.test.ts
expectedUserBehavior:
  - 普通应用行为不变，日志仍然可用于排障。
  - logger 写入控制台、内存 ring buffer 和日志文件前会脱敏。
  - 设置/诊断页面读取 LYClaw 和 Gateway 日志 tail 时会再次脱敏。
  - 日志里不应出现 Bearer token、provider key、URL userinfo、api_key/token/password/secret 明文。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-secret-redactor-logging.md
  - pnpm exec vitest run tests/unit/logger-redaction.test.ts tests/unit/diagnostics-routes.test.ts tests/unit/security-secret-scanner.test.ts
acceptance:
  - logger.ts 格式化 message、object、Error 前复用统一 secret redactor。
  - logger.readLogFile 返回内容前复用统一 secret redactor。
  - diagnostics gateway log tail 返回前复用统一 secret redactor。
  - 单元测试覆盖普通 logger 和诊断接口脱敏。
docs:
  required: false
---

## Notes

本阶段只覆盖运行日志和诊断日志展示；不在本阶段处理发送模型前拦截、Transcript、Memory、文件上传内容扫描或用户确认弹窗。
