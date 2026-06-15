---
id: restore-legacy-skill-runtime-compatibility
title: 恢复历史本地 Skill 的运行时兼容性
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 修复 Skill 运行时权限模型上线后，历史已安装或预装 Skill 因缺少 SkillGrant 而无法执行的问题，同时保持文件、网络和命令策略继续生效。
touchedAreas:
  - electron/security/skill-runtime-policy.ts
  - tests/unit/security-skill-runtime-policy.test.ts
expectedUserBehavior:
  - 安全授权中心上线前已经安装的本地 Skill 仍可被 Agent 使用。
  - 只有本地 SKILL.md 摘要与 Runtime 上报的 manifestDigest 完全一致时，才进入 legacy 兼容路径。
  - legacy Skill 不会绕过后续文件路径、网络访问和命令执行策略。
  - 已有 SkillGrant 的新 Skill 继续按 manifest 权限声明严格判断。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm exec vitest run tests/unit/security-skill-runtime-policy.test.ts tests/unit/gateway-exec-approval-bridge.test.ts
acceptance:
  - 没有持久化 SkillGrant 的历史本地 Skill，在 SKILL.md digest 匹配时不会被 SKILL_RUNTIME_GRANT_REQUIRED 直接拒绝。
  - digest 不匹配或本地 SKILL.md 不存在的 Skill 仍按缺少授权拒绝。
  - legacy 兼容路径只跳过声明层硬拒绝，仍委托命令、网络和路径策略做最终决策。
docs:
  required: false
---

## Notes

本阶段是回归修复，不改变新上传 Skill 的权限确认流程。legacy 兼容只适用于本机已存在且 manifestDigest 匹配的 Skill，用于避免安全授权中心上线前安装的个人 Skill 被误伤。
