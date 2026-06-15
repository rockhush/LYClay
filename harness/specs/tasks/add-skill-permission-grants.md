---
id: add-skill-permission-grants
title: 新增 Skill 授权持久化与撤销管理
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将本地 ZIP 安装确认后的 Skill 权限保存到 Main 进程授权中心，并支持 manifest 变化失效、卸载撤销和安全设置页管理。
touchedAreas:
  - electron/security/types.ts
  - electron/security/permission-store.ts
  - electron/security/audit-log.ts
  - electron/api/routes/security.ts
  - electron/api/routes/skills.ts
  - electron/main/ipc-handlers.ts
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-permission-store.test.ts
  - tests/unit/security-routes.test.ts
  - tests/unit/security-settings-page.test.tsx
  - tests/e2e/security-settings.spec.ts
expectedUserBehavior:
  - 用户安装本地 ZIP Skill 后，Main 进程保存 Skill 标识、manifest 摘要和已确认权限。
  - 相同 Skill 的 manifest 内容发生变化后，旧授权自动失效，不能继续作为升级权限基线。
  - 用户卸载 Skill 后，对应的有效授权自动撤销。
  - 用户可以在设置的安全授权页查看 Skill 授权并主动撤销。
  - 授权、撤销和因 manifest 变化失效均写入安全审计日志。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-skill-permission-grants.md
  - pnpm exec vitest run tests/unit/security-permission-store.test.ts tests/unit/security-routes.test.ts tests/unit/security-settings-page.test.tsx
  - pnpm run build:vite
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - permission-store 将 Skill grant 与既有路径、域名、命令和 MCP 授权保存在同一授权文件中。
  - Skill grant 使用 manifest SHA-256 摘要绑定已确认权限。
  - Skill 升级权限 diff 只信任仍然有效且摘要匹配的已保存授权，不直接信任磁盘中的旧 manifest。
  - 新 manifest 保存授权时，旧 manifest 对应授权被标记为失效并写入审计日志。
  - ZIP 安装完成后保存授权；卸载 Skill 时撤销对应有效授权。
  - 安全设置页展示 Skill 授权，并允许用户撤销。
docs:
  required: true
---

# 范围

本阶段只实现 Skill 安装授权的持久化、失效、撤销和 Settings 管理闭环。

# 非目标

- 不实现 Skill 运行时身份绑定。
- 不实现 Skill 运行时文件、网络或命令越权拦截。
- 不实现插件授权持久化。
- 不实现 Marketplace Skill 权限声明补录。
