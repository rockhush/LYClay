---
id: add-security-audit-log
title: 添加安全审计日志收口
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将安全策略决策、用户确认选择、授权 grant/revoke 记录为统一审计事件，为后续安全设置 UI 和问题追踪提供稳定数据结构。
touchedAreas:
  - electron/security/audit-log.ts
  - electron/security/types.ts
  - electron/security/policy-engine.ts
  - electron/security/confirmation-service.ts
  - electron/security/permission-store.ts
  - tests/unit/security-audit-log.test.ts
expectedUserBehavior:
  - 现有安全拦截、确认和授权行为保持不变。
  - 通过 policy-engine 的 allow/prompt/deny 决策会生成审计事件。
  - 用户确认 deny/allow-once/allow-session/allow-persistent 会生成审计事件。
  - 文件、目录、域名授权和撤销会生成审计事件。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-audit-log.md
  - pnpm exec vitest run tests/unit/security-audit-log.test.ts tests/unit/security-policy-engine.test.ts tests/unit/security-confirmation-service.test.ts tests/unit/security-permission-store.test.ts
acceptance:
  - audit-log.ts 暴露 auditSecurityEvent、auditPolicyDecision、auditConfirmationDecision、auditPermissionGrant、auditPermissionRevoke。
  - audit-log.ts 保留 auditPathDecision 兼容旧路径策略入口。
  - policy-engine 统一记录策略决策。
  - confirmation-service 记录用户确认结果。
  - permission-store 记录 grant/revoke 事件。
  - 单元测试覆盖策略决策、授权变更和确认选择。
docs:
  required: false
---

## Notes

本阶段只做底层审计写入和测试，不实现 Settings 审计日志查看 UI，也不做持久化审计查询 API。后续 UI 阶段可基于 SecurityAuditEvent 结构扩展。
