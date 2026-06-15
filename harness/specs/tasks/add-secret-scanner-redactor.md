---
id: add-secret-scanner-redactor
title: 新增统一 Secret 扫描与脱敏基础模块
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为日志、审计、后续发送模型前检查提供统一的 secret scanner / redactor，先接入审计日志落盘与内存事件，避免安全事件里写入明文凭据。
touchedAreas:
  - electron/security/secret-scanner.ts
  - electron/security/audit-log.ts
  - tests/unit/security-secret-scanner.test.ts
  - tests/unit/security-audit-log.test.ts
expectedUserBehavior:
  - 现有安全策略、确认弹窗和授权行为保持不变。
  - 审计日志继续记录安全事件，但 Bearer token、API key、JWT、SSH 私钥、URL 凭据等会被脱敏。
  - 扫描结果只返回脱敏 excerpt，不把命中的 secret 明文暴露给 UI 或日志。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-secret-scanner-redactor.md
  - pnpm exec vitest run tests/unit/security-secret-scanner.test.ts tests/unit/security-audit-log.test.ts
acceptance:
  - 新增 secret-scanner.ts，提供 scanSecrets、redactSecrets、redactUnknown。
  - 支持识别 Bearer token、provider key、GitHub token、AWS access key、JWT、SSH private key、URL userinfo 和常见 key=value secret。
  - audit-log.ts 复用统一 redactor，不再维护私有脱敏规则。
  - 单元测试覆盖扫描、字符串脱敏、对象脱敏和审计日志落盘脱敏。
docs:
  required: false
---

## Notes

本阶段只做 Secrets 防泄漏的基础能力和审计日志接入；不在本阶段拦截发送模型前内容，也不处理 Memory、Transcript、Gateway stdout/stderr 或错误上报链路。
