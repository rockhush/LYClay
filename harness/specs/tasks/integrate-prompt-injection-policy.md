---
id: integrate-prompt-injection-policy
title: 接入提示词注入安全扫描策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将第六阶段的 Prompt Injection Policy 接入 Skill 与 MCP 的真实校验入口，防止恶意 SKILL.md、MCP server 描述或工具描述进入 Agent 可用上下文。
touchedAreas:
  - electron/security/**
  - electron/utils/skill-validator.ts
  - electron/utils/mcp-config-validator.ts
  - tests/unit/security-prompt-injection-integration.test.ts
expectedUserBehavior:
  - 安全的 SKILL.md 可以继续通过安装/加载前校验。
  - SKILL.md 中出现忽略系统指令、绕过用户确认、凭据窃取或数据外传等高风险内容时，安装/加载前校验会失败。
  - 安全的 MCP server 配置可以继续通过保存/校验。
  - MCP server 描述或嵌套 tool 描述中出现高风险提示词注入内容时，配置校验会失败。
  - 被拦截时返回可读原因，不能静默丢弃或让恶意内容继续进入后续流程。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-prompt-injection-policy.md
  - pnpm exec vitest run tests/unit/security-prompt-injection-policy.test.ts tests/unit/security-prompt-injection-integration.test.ts tests/unit/mcp-config-validator.test.ts
acceptance:
  - Skill manifest 校验会扫描完整 SKILL.md，而不只扫描 description。
  - MCP config 校验会扫描 description、instructions、prompt、systemPrompt 等描述类字段，并递归覆盖嵌套 tool 描述。
  - 高风险/关键风险 Skill 或 MCP 描述会被转成校验错误。
  - 安全 Skill 和 MCP 配置不应被误伤。
  - 单元测试覆盖安全通过、Skill 阻断、MCP server 描述阻断、MCP tool 描述阻断。
docs:
  required: false
---

## Notes

本阶段先接入 Skill 与 MCP 校验入口，不做 UI 弹窗、用户确认持久化、Memory 写入扫描、附件内容扫描或知识库导入扫描。这些入口可在后续阶段继续接入同一个策略中心。
