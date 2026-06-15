---
id: add-security-policy-engine
title: 添加统一 Security Policy Engine
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为文件、命令、网络、打开目标和 prompt injection 扫描提供 Main 进程统一安全策略入口，避免后续安全能力继续分散接入。
touchedAreas:
  - electron/security/policy-engine.ts
  - electron/security/index.ts
  - electron/security/types.ts
  - electron/security/open-target-policy.ts
  - tests/unit/security-policy-engine.test.ts
expectedUserBehavior:
  - 现有安全策略行为保持不变。
  - 新的 policy-engine 能统一返回 SecurityDecision，供 UI、审计和后续入口迁移复用。
  - prompt/deny 决策通过 assertSecurityAllowed 抛出带 code 和 decision 的错误。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-security-policy-engine.md
  - pnpm exec vitest run tests/unit/security-policy-engine.test.ts
acceptance:
  - evaluateSecurityPolicy 能调度 file/path 策略。
  - evaluateSecurityPolicy 能调度 command 策略。
  - evaluateSecurityPolicy 能调度 network 策略。
  - evaluateSecurityPolicy 能调度 open-target 策略。
  - evaluateSecurityPolicy 能调度 prompt-scan 策略。
  - assertSecurityAllowed 对非 allow 决策抛出结构化错误。
docs:
  required: false
---

## Notes

本阶段只新增统一入口和测试，不要求一次性迁移所有调用点。后续阶段会逐步把 Main/Renderer/Gateway/Skill/MCP 等能力入口改为调用 policy-engine。
