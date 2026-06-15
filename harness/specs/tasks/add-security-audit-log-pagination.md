---
id: add-security-audit-log-pagination
title: 为安全审计日志增加分页
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为安全设置页的审计日志增加服务端分页，避免一次加载和展示大量安全事件。
touchedAreas:
  - electron/security/audit-log.ts
  - electron/api/routes/security.ts
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-audit-log.test.ts
  - tests/unit/security-routes.test.ts
  - tests/unit/security-settings-page.test.tsx
  - tests/e2e/security-settings.spec.ts
expectedUserBehavior:
  - 审计日志默认每页显示 10 条记录。
  - 用户可以选择每页显示 10、20 或 50 条。
  - 页面显示当前记录范围、总记录数和当前页数。
  - 用户可以使用上一页和下一页浏览记录。
  - 修改能力或结果筛选后自动返回第一页。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-audit-log-pagination.md
  - pnpm exec vitest run tests/unit/security-audit-log.test.ts tests/unit/security-routes.test.ts tests/unit/security-settings-page.test.tsx
acceptance:
  - Renderer 继续通过 hostApiFetch 调用 Main 提供的安全审计接口。
  - API 接受 page 和 pageSize，并返回 events、total、page、pageSize、totalPages。
  - 旧 limit 查询保持兼容。
  - 分页边界不会产生负页码或超过末页。
  - Electron E2E 覆盖分页控件的可见性。
docs:
  required: false
---

## Notes

本阶段只实现审计日志分页，不加入清空、导出或全文搜索。
