---
id: add-skill-upload-permission-review
title: 新增 Skill 上传安装前权限确认
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在本地 Skill ZIP 安装前展示 manifest 权限 diff，并由 Main 进程签发短期确认令牌，防止 Renderer 直接跳过权限预览落盘安装。
touchedAreas:
  - electron/security/skill-permission-policy.ts
  - electron/security/skill-upload-confirmation.ts
  - electron/utils/skill-validator.ts
  - electron/main/ipc-handlers.ts
  - src/components/skills/UploadSkillDialog.tsx
  - src/pages/Skills/index.tsx
  - src/i18n/locales/en/skills.json
  - src/i18n/locales/zh/skills.json
  - tests/unit/security-skill-permission-policy.test.ts
  - tests/unit/security-skill-upload-confirmation.test.ts
  - tests/unit/upload-skill-dialog-permissions.test.tsx
  - tests/e2e/skill-upload-permission-review.spec.ts
expectedUserBehavior:
  - 上传结果中的阻断项明确标记为“已阻止上传”，脚本类 warning 明确标记为“仅提醒”，避免用户误认为 warning 导致安装失败。
  - Python bytecode files (`.pyc` and `.pyo`) produce upload warnings rather than blocking the ZIP; native executables and archive safety limits remain blocking.
  - 本地 ZIP 可直接包含 SKILL.md，也可以使用唯一顶层文件夹包裹 SKILL.md。
  - ZIP 顶层结构存在多个目录或额外文件且无法唯一确定 Skill 根目录时，安装会被拒绝。
  - Skill 默认继承已授权 Workspace 内的 metadata、read 和 write 基础能力，无需在 manifest 中重复声明。
  - 默认 Workspace 基础能力不会放宽敏感路径和 Workspace 外路径限制，也不会赋予插件默认权限。
  - 用户上传仅包含 Workspace 基础权限的合法 Skill ZIP 后，应用无需重复确认即可完成安装。
  - 用户上传新增网络、命令、删除或执行能力的 Skill ZIP 后，应用先展示新增权限和已有权限，不会立即写入本地技能目录。
  - 用户确认后，Renderer 带回 Main 签发的短期确认令牌，Main 再次校验同一 ZIP 后完成安装。
  - Renderer 直接请求安装、令牌缺失、令牌过期或令牌与 ZIP 不匹配时，Main 拒绝安装。
  - manifest 中包含非法权限声明时，安装在进入权限预览前被阻断。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-skill-upload-permission-review.md
  - pnpm exec vitest run tests/unit/skill-validator.test.ts
  - pnpm exec vitest run tests/unit/security-skill-permission-policy.test.ts tests/unit/security-skill-upload-confirmation.test.ts tests/unit/upload-skill-dialog-permissions.test.tsx tests/unit/security-prompt-injection-integration.test.ts
  - pnpm run build:vite
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - validateExtractedSkill() 能解析 ZIP 根目录和唯一顶层文件夹中的 SKILL.md，并返回实际 Skill 根目录。
  - 最终安装只移动经过校验的实际 Skill 根目录，不产生重复嵌套目录。
  - 未声明 permissions 的 Skill 获得 workspace:metadata、workspace:read 和 workspace:write 基础权限。
  - 插件未声明 permissions 时仍保持空权限集合。
  - 首次安装的权限 diff 将 Workspace 基础能力归入基础或已有权限，仅将额外能力归入新增权限。
  - skill:uploadZip 仅在新增额外能力时返回结构化权限 diff 和短期 confirmationToken。
  - 新增额外能力的 autoInstall=true 请求必须携带与同一 ZIP 匹配且未过期的 confirmationToken。
  - UploadSkillDialog 展示新增权限、已有权限和风险等级，并在用户确认后继续安装。
  - E2E spec 覆盖上传、权限预览和确认安装流程。
docs:
  required: true
---

# 范围

本阶段只覆盖用户从本地上传 ZIP 安装 Skill 的流程。

# 非目标

- 不实现 Skill 运行时身份绑定。
- 不实现 Skill 运行时文件、网络或命令越权拦截。
- 不实现插件安装 UI。
- 不实现 MCP 工具逐次确认。
