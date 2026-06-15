---
id: add-skill-runtime-security-policy
title: 新增 Skill 运行时权限策略基础
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 Skill 安装授权用于运行时文件、网络和命令能力判断，并在 Gateway exec approval 携带可信 Skill 上下文时先执行 Skill 权限校验。
touchedAreas:
  - electron/security/types.ts
  - electron/security/skill-runtime-policy.ts
  - electron/security/index.ts
  - electron/gateway/exec-approval-bridge.ts
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-skill-runtime-policy.test.ts
  - tests/unit/gateway-exec-approval-bridge.test.ts
expectedUserBehavior:
  - Skill 运行时只能使用当前 manifest 对应的有效授权。
  - Skill 未声明的文件、网络或命令能力会被拒绝。
  - Skill 已声明的能力仍继续经过路径、网络和命令策略，不能绕过敏感路径、私网阻断或危险命令规则。
  - Gateway exec approval 携带完整 Skill 身份时，Main 在命令策略前先校验 Skill 命令声明。
  - Gateway exec approval 不携带 Skill 身份时，继续按普通 Agent 命令处理。
  - Gateway exec approval 只携带部分 Skill 身份字段时，Main 拒绝执行，不降级为普通 Agent。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-skill-runtime-security-policy.md
  - pnpm exec vitest run tests/unit/security-skill-runtime-policy.test.ts tests/unit/gateway-exec-approval-bridge.test.ts
  - pnpm run build:vite
  - pnpm run comms:replay
  - pnpm run comms:compare
acceptance:
  - Skill runtime context 包含 skillId、manifestDigest 和可选 source。
  - Skill runtime policy 能按有效 grant 校验文件、网络和命令声明。
  - 文件声明校验后继续调用 path-policy。
  - 网络声明校验后继续调用 network-policy。
  - 命令声明校验后继续调用 command-policy。
  - Skill runtime allow 和 deny 决策写入统一审计日志。
  - Gateway exec approval bridge 对完整、缺失和部分 Skill 身份分别执行校验、普通 Agent 降级和拒绝策略。
docs:
  required: true
---

# 范围

本阶段建立 Skill runtime policy 基础，并接入 Gateway exec approval 已能承载的可选 Skill 上下文。

# 非目标

- 不伪造 Gateway 当前未提供的 Skill 身份。
- 不实现 OpenClaw 内部所有工具调用的 Skill 身份透传。
- 不实现插件权限。
- 不实现本地 HTTP/CONNECT egress proxy。
