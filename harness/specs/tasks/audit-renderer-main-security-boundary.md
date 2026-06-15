---
id: audit-renderer-main-security-boundary
title: 收口 Renderer 与 Main 安全边界
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 Renderer 页面、组件、store 中的本地能力请求统一迁移到 api-client、host-api、host-events 等封装层，避免 Renderer 自行直连 IPC 或绕过 Main 进程安全策略。
touchedAreas:
  - src/lib/api-client.ts
  - src/lib/host-events.ts
  - src/lib/security-confirmation.ts
  - src/App.tsx
  - src/components/workspace/WorkspacePicker.tsx
  - src/components/file-browser/FileTree.tsx
  - src/components/layout/Sidebar.tsx
  - src/components/channels/ChannelConfigModal.tsx
  - src/components/security/SecurityConfirmationDialog.tsx
  - src/pages/Settings/index.tsx
  - src/stores/file-tree.ts
  - src/stores/update.ts
  - tests/unit/renderer-main-boundary.test.ts
expectedUserBehavior:
  - 文件选择、文件树、打开本地路径、打开外部链接、安全确认弹窗、设置页事件和更新事件行为保持不变。
  - Renderer 不再在页面、组件、store 中直接调用 window.electron.ipcRenderer。
  - 安全确认弹窗只回传用户选择，真正授权写入和策略判断仍由 Main 进程完成。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/audit-renderer-main-security-boundary.md
  - pnpm exec vitest run tests/unit/renderer-main-boundary.test.ts tests/unit/security-confirmation-dialog.test.tsx tests/unit/host-events.test.ts
acceptance:
  - 直接 IPC 调用只允许存在于 src/lib/api-client.ts 和 src/lib/host-events.ts。
  - Renderer 文件中不得直接调用 window.electron.openExternal。
  - Renderer 文件中不得直接 fetch localhost / 127.0.0.1 后端地址。
  - 安全确认弹窗通过 src/lib/security-confirmation.ts 订阅请求并回传选择。
docs:
  required: false
---

# 收口 Renderer 与 Main 安全边界

本阶段对应安全表格中的：

- 总体架构 / Renderer 只能发起请求，不能自行授权
- 总体架构 / Main 进程拥有安全决策权

核心边界是：Renderer 可以发起 UI 请求，但不能在页面、组件、store 中直接绕过统一封装访问 IPC、本地 HTTP 或外部链接打开能力。所有本地能力请求都应先进入 Main 进程已有的路由、安全策略、确认服务和审计链路。
