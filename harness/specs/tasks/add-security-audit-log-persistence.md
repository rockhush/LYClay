---
id: add-security-audit-log-persistence
title: 添加安全审计日志持久化与查询 API
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 SecurityAuditEvent 以 JSONL 形式持久化到本地，并提供 Host API 查询能力，为后续 Settings 审计日志 UI 提供稳定数据源。
touchedAreas:
  - electron/security/audit-log.ts
  - electron/api/routes/security.ts
  - tests/unit/security-audit-log.test.ts
  - tests/unit/security-routes.test.ts
expectedUserBehavior:
  - 现有安全决策、确认和授权行为保持不变。
  - 安全审计事件会写入本地 JSONL 文件。
  - 审计日志超过大小限制会做简单轮转。
  - Host API 可以按 limit、capability、decision、source 查询审计事件。
  - 审计日志会对 URL 凭据、Bearer token、api_key/password/token/secret 等明显敏感字段做基础脱敏。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-audit-log-persistence.md
  - pnpm exec vitest run tests/unit/security-audit-log.test.ts tests/unit/security-routes.test.ts
acceptance:
  - auditSecurityEvent 追加写入 JSONL。
  - querySecurityAuditEvents 能从文件和内存返回去重后的最近事件。
  - 查询支持 capability、decision、source、limit 过滤。
  - /api/security/audit-events 返回 { success: true, events }。
  - 单元测试覆盖持久化、脱敏、轮转和 API 查询。
docs:
  required: false
---

## Notes

本阶段不实现 Settings 审计日志 UI，也不实现完整 secret scanner。完整 secret scanner/redactor 放到后续 Secrets 防泄漏阶段。
