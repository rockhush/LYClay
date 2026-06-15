---
id: integrate-gateway-runtime-exec-policy
title: Gateway runtime exec 接入命令安全策略
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 Agent 通过 Gateway runtime exec tool 发起的命令执行请求桥接到 LYClaw Main 进程的 command-policy / path-policy，防止 exec 绕过 workspace 授权和敏感路径拦截。
touchedAreas:
  - electron/gateway/exec-approval-bridge.ts
  - electron/gateway/manager.ts
  - electron/utils/openclaw-auth.ts
  - electron/security/command-policy.ts
  - tests/unit/gateway-exec-approval-bridge.test.ts
  - tests/unit/openclaw-auth.test.ts
expectedUserBehavior:
  - Agent runtime exec 读取 workspace 外文件会被拒绝。
  - Agent runtime exec 读取 .ssh、.env 等敏感路径会被拒绝。
  - Agent runtime exec 的低风险 workspace 内命令可由策略自动放行。
  - Agent runtime exec 的中高风险命令继续走 LYClaw 安全确认。
  - LYClaw 内部维护命令不弹 Agent 命令确认。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/integrate-gateway-runtime-exec-policy.md
  - pnpm exec vitest run tests/unit/gateway-exec-approval-bridge.test.ts tests/unit/security-command-policy.test.ts
  - pnpm exec vitest run tests/unit/openclaw-auth.test.ts -t "enables schema-compatible exec approval events"
acceptance:
  - sanitizeOpenClawConfig 使用当前 OpenClaw schema 支持的 tools.exec.ask="always"，且不写入 askFallback。
  - GatewayManager 收到 exec.approval.requested 后会获取 approval 详情。
  - approval command/cwd 会调用 assertCommandAllowedWithConfirmation。
  - command-policy allow 后调用 exec.approval.resolve decision="allow-once"。
  - command-policy deny 或用户拒绝后调用 exec.approval.resolve decision="deny"。
docs:
  required: false
---

## Notes

本阶段只桥接 Gateway runtime exec approval 到 LYClaw Main 安全策略。不要通过未知 openclaw.json 字段扩展 schema，不做网络代理、OS 沙箱、Skill/MCP 权限模型或命令授权管理 UI。
