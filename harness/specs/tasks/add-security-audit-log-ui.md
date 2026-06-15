---
id: add-security-audit-log-ui
title: 添加安全审计日志 UI
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在 Settings 安全页面展示持久化安全审计事件，并提供基础筛选和刷新能力，让用户能理解安全策略、确认和授权变更记录。
touchedAreas:
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-settings-page.test.tsx
  - tests/e2e/security-settings.spec.ts
expectedUserBehavior:
  - 设置里的安全页面包含“授权管理”和“审计日志”两个视图。
  - 审计日志视图展示最近安全事件的时间、来源、能力、操作、目标、结果、风险、原因和错误代码。
  - 用户可以按 capability、decision 和数量筛选审计事件。
  - 用户可以刷新审计日志。
  - 空状态和加载状态可见。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-audit-log-ui.md
  - pnpm exec vitest run tests/unit/security-settings-page.test.tsx
acceptance:
  - Renderer 使用 hostApiFetch 调用 /api/security/audit-events，不直接访问 localhost。
  - 授权管理原有域名、文件授权功能保持可用。
  - 审计日志筛选参数正确传给 Host API。
  - 单元测试覆盖审计日志渲染和筛选。
  - E2E spec 覆盖安全页面审计日志 tab 的基本可见性。
docs:
  required: false
---

## Notes

本阶段不实现审计日志清空、导出、实时流或详情抽屉。完整 secret scanner/redactor 仍放在后续 Secrets 防泄漏阶段。
