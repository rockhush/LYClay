---
id: add-security-settings-grants-ui
title: 添加安全授权管理页面
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为前置安全策略增加最小 UI 闭环，允许用户在 Settings 中查看文件/Workspace 授权和域名授权，并撤销已有授权或手动添加域名授权。
touchedAreas:
  - electron/api/routes/security.ts
  - electron/api/server.ts
  - src/pages/Settings/**
  - src/App.tsx
  - tests/unit/security-routes.test.ts
  - tests/unit/security-settings-page.test.tsx
  - tests/e2e/security-settings.spec.ts
expectedUserBehavior:
  - 用户可以从 Settings 打开 Security 授权管理页。
  - Security 页面会列出当前有效的 path grants 和 domain grants。
  - 用户可以撤销 path grant 或 domain grant。
  - 用户可以手动添加 domain grant，并选择是否包含子域名、是否永久保存。
  - 所有授权数据仍由 Main 进程读取和写入，Renderer 只通过 Host API 请求。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-settings-grants-ui.md
  - pnpm exec vitest run tests/unit/security-routes.test.ts tests/unit/security-settings-page.test.tsx
  - pnpm run test:e2e -- tests/e2e/security-settings.spec.ts
acceptance:
  - 新增 /api/security/grants 查询接口。
  - 新增 domain grant 创建接口。
  - 新增 path/domain grant 撤销接口。
  - 新增 /settings/security 页面并接入路由。
  - Settings 主页面提供安全授权入口。
  - 单元测试覆盖 Host API 路由和页面渲染/添加域名授权。
  - E2E 测试覆盖 Security 页面可打开并展示授权管理入口。
docs:
  required: false
---

## Notes

本阶段不做命令执行确认弹窗、网络自动确认弹窗、Prompt Injection 绕过 UI 或完整审计日志中心。确认弹窗和审计中心后续阶段继续接入。
