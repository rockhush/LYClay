---
id: add-prompt-injection-security-policy
title: 添加提示词注入安全扫描策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 添加独立的 Prompt / Skill / Memory / MCP 文本安全扫描中心，在文本进入 Agent 上下文或被作为能力说明使用前识别提示词注入、权限绕过、凭据窃取、数据外传、隐藏行为和身份劫持风险。
touchedAreas:
  - electron/security/**
  - tests/unit/security-prompt-injection-policy.test.ts
expectedUserBehavior:
  - 普通 Skill、Memory、MCP、知识库或附件文本默认允许。
  - Skill / MCP 描述命中高风险或关键风险提示词注入规则时返回拒绝。
  - Memory / 知识库 / Transcript / 附件命中关键风险规则时返回拒绝。
  - 附件中的高风险研究样例可以先返回需要确认，而不是直接拒绝。
  - 扫描结果只保留短证据片段，不把整段可疑文本写入结果。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-prompt-injection-security-policy.md
  - pnpm exec vitest run tests/unit/security-prompt-injection-policy.test.ts
acceptance:
  - 新增 prompt-injection policy 模块，并复用统一 SecurityDecision 结构。
  - 支持 skill、memory、mcp、knowledge、transcript、attachment、unknown 来源类型。
  - 支持识别忽略系统指令、权限绕过、凭据窃取、数据外传、隐藏行为和身份劫持规则。
  - 不同来源可以有不同拒绝阈值，避免附件安全研究文本被一律直接阻断。
  - 单元测试覆盖中英文规则、风险分级、拒绝/确认决策、证据片段截断和大文本稳定性。
docs:
  required: false
---

## Notes

本阶段只实现扫描器内核和单元测试，不接入真实 Skill 加载、Memory 读写、MCP 描述加载、知识库导入或附件解析流程。后续阶段再把该策略接入具体入口，并设计用户确认 UI。
