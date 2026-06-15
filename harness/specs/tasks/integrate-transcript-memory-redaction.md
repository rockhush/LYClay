---
id: integrate-transcript-memory-redaction
title: 接入 Transcript 与 Memory 可控出口脱敏
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在 LYClaw Main 进程将本地 Transcript 内容返回 Renderer 前统一递归脱敏，并提供可复用于后续 Memory 正文出口的结构化脱敏能力。
touchedAreas:
  - electron/security/secret-scanner.ts
  - electron/api/routes/sessions.ts
  - tests/unit/security-secret-scanner.test.ts
  - tests/unit/sessions-transcript-redaction.test.ts
expectedUserBehavior:
  - 会话列表和历史消息仍可正常加载。
  - 子 Agent Transcript 仍可正常展示。
  - Transcript 中出现 API key、Bearer token、JWT、SSH 私钥或敏感字段字符串时，Renderer 只能收到脱敏后的内容。
  - OpenClaw 自身直接写入的原始 Transcript 与 Memory 文件不会在本阶段改写。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-transcript-memory-redaction.md
  - pnpm exec vitest run tests/unit/security-secret-scanner.test.ts tests/unit/sessions-transcript-redaction.test.ts
acceptance:
  - 结构化脱敏函数递归处理字符串、数组和对象。
  - 结构化脱敏函数隐藏敏感字段中的字符串，同时保留 totalTokens 等数值元数据。
  - sessions list-local 的标题与预览在返回 Renderer 前脱敏。
  - sessions history-local 的消息和 prompt error 在返回 Renderer 前脱敏。
  - sessions transcript 的子 Agent 消息在返回 Renderer 前脱敏。
docs:
  required: false
---

## Notes

本阶段只治理 LYClaw 可控的 Transcript 数据出口，并为后续明确的 Memory 正文出口提供复用函数。OpenClaw Runtime 内部直接读写的原始 Transcript 与 Memory 文件不在本阶段改写，因此表格中的 Transcript / Memory 脱敏应标记为“部分实现”。
