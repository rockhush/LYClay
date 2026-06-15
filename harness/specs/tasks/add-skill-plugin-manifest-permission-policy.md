---
id: add-skill-plugin-manifest-permission-policy
title: 新增 Skill / 插件 manifest 权限声明校验
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为 Skill 和插件建立统一、最小权限的 manifest 声明格式，在 Skill ZIP 安装校验阶段阻止无法解释或明显越权的权限声明，并为后续权限 diff UI 和运行时身份绑定提供稳定数据结构。
touchedAreas:
  - electron/security/skill-permission-policy.ts
  - electron/security/index.ts
  - electron/utils/skill-validator.ts
  - tests/unit/security-skill-permission-policy.test.ts
  - tests/unit/security-prompt-injection-integration.test.ts
expectedUserBehavior:
  - 未声明 permissions 的 Skill 仍可通过安装校验，并继承已授权 Workspace 内的 metadata、read 和 write 基础能力。
  - 声明 workspace 读取、写入、明确域名和具体命令的 Skill 可通过结构校验。
  - 请求任意主机文件、任意网络、Shell 启动器或 Secrets 的 Skill 会在进入本地技能目录前被阻止。
  - 本阶段不新增权限确认弹窗，也不声称已经完成 Skill 运行时越权拦截。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-skill-plugin-manifest-permission-policy.md
  - pnpm exec vitest run tests/unit/security-skill-permission-policy.test.ts tests/unit/security-prompt-injection-integration.test.ts
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - skill-permission-policy.ts 提供 Skill 和插件可复用的权限对象校验入口。
  - SKILL.md frontmatter permissions 支持 filesystem、network、commands、secrets 四类简单列表。
  - 未声明权限的 Skill 返回 Workspace 基础权限集合；未声明权限的插件仍返回空权限集合。
  - 未知字段、错误类型、通配符主机权限、通配符网络权限、Shell 启动器和 Secrets 读取会返回 deny。
  - validateExtractedSkill() 将权限声明错误合并为 manifest finding。
docs:
  required: true
---

# 目标

为 Skill 和插件提供统一、可复用的 manifest 权限声明模型，并将 Skill 声明校验接入现有 ZIP 安装校验链路。

# 范围

- 支持 `filesystem`、`network`、`commands`、`secrets` 四类权限声明。
- 未声明权限的 Skill 按已授权 Workspace 内 metadata、read 和 write 基础能力处理；插件仍按空权限处理。
- 阻止任意主机文件、任意域名、Shell 启动器和 Secrets 读取声明。
- 阻止未知字段、错误类型和无法解释的权限值。
- 将 Skill frontmatter 声明校验合并到 `validateExtractedSkill()`。
- 提供插件 manifest 可复用的对象校验入口。

# 非目标

- 不新增 Skill 权限确认弹窗。
- 不实现 Skill 升级权限 diff UI。
- 不在本阶段实现 Skill 运行时身份绑定和完整越权拦截。
- 不修改 MCP 逐工具授权策略。
