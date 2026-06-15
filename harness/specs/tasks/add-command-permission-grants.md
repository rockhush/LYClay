---
id: add-command-permission-grants
title: 添加命令授权规则管理
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将用户在命令安全确认弹窗中选择的“本会话允许 / 永久允许”写入 permission-store，并在安全设置页展示、撤销和审计，避免命令授权只存在内存中不可管理。
touchedAreas:
  - electron/security/permission-store.ts
  - electron/security/confirmation-service.ts
  - electron/security/audit-log.ts
  - electron/api/routes/security.ts
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-confirmation-service.test.ts
  - tests/unit/security-routes.test.ts
  - tests/unit/security-settings-page.test.tsx
expectedUserBehavior:
  - 用户选择命令“允许一次”后，不产生可复用命令授权。
  - 用户选择命令“本会话允许”后，同一命令、同一 cwd、同一来源在本次应用会话内不再重复弹窗。
  - 用户选择命令“永久允许”后，同一命令、同一 cwd、同一来源在重启后仍可复用授权。
  - 用户可以在安全设置页看到命令授权并撤销。
  - 命令授权新增和撤销会进入审计日志。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-command-permission-grants.md
  - pnpm exec vitest run tests/unit/security-confirmation-service.test.ts tests/unit/security-routes.test.ts tests/unit/security-settings-page.test.tsx
acceptance:
  - permission-store 支持 commandGrants 的 session/persistent 存储、查找、撤销和过期过滤。
  - confirmation-service 不再使用仅内存的 commandSessionGrants，而是通过 permission-store 查找和写入命令授权。
  - /api/security/grants 返回 commandGrants。
  - /api/security/grants/command/:id 支持撤销命令授权。
  - Settings 安全授权页展示命令授权列表，并能调用 Host API 撤销。
  - allow-once 不写入 commandGrants。
docs:
  required: false
---

## Notes

本阶段只做命令授权规则管理，不扩大命令策略规则、不接入 OS 沙箱、不做命令授权编辑器或通配规则。命令授权必须精确绑定 command + cwd + source，避免“允许 npm install”变成过宽权限。
