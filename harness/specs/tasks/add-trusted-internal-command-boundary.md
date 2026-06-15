---
id: add-trusted-internal-command-boundary
title: 收口可信内部命令执行边界
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 将 LYClaw 自身固定维护命令从 Agent 动态命令确认流中分离出来，通过 Main 进程的可信内部命令注册表做结构化校验和审计，避免 Gateway 重启、端口清理、后台 doctor 修复等固定动作误弹用户确认。
touchedAreas:
  - electron/security/trusted-internal-command.ts
  - electron/security/types.ts
  - electron/gateway/process-launcher.ts
  - electron/gateway/supervisor.ts
  - src/pages/Settings/SecuritySettings.tsx
  - tests/unit/security-trusted-internal-command.test.ts
  - tests/unit/gateway-supervisor.test.ts
  - tests/unit/gateway-process-launcher-redaction.test.ts
expectedUserBehavior:
  - Gateway 启动、停止时的固定进程维护命令不会误弹 Agent 命令确认。
  - 后台 OpenClaw doctor repair 仍被限制为固定参数形状，但不再要求用户为自动恢复流程确认。
  - Agent、Skill、MCP 或 Renderer 传入的动态命令仍继续走 command-policy 和确认弹窗。
  - 内部维护命令的 allow / deny 会进入安全审计日志，可在 Settings 审计日志中按内部命令筛选。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/add-trusted-internal-command-boundary.md
  - pnpm exec vitest run tests/unit/security-trusted-internal-command.test.ts tests/unit/gateway-supervisor.test.ts tests/unit/gateway-process-launcher-redaction.test.ts
acceptance:
  - 新增 trusted-internal-command 模块，只接受枚举 operation 和结构化 executable/args。
  - Gateway launch 必须匹配入口脚本、gateway 子命令和数字 port。
  - Gateway 端口查询和进程树清理只能使用固定工具和数字端口/PID。
  - Gateway doctor repair 只能使用 openclaw doctor --fix --yes --non-interactive。
  - 允许和拒绝的内部命令均写入 capability=internal-command 的审计事件。
  - 安全设置审计筛选支持 internal-command。
docs:
  required: true
---

## Notes

本阶段只处理 LYClaw 自身固定维护命令，不为用户、Agent、Skill、MCP 或插件提供通用绕过入口。动态命令、安装命令、MCP stdio 启动命令仍必须继续使用 command-policy、确认服务和对应权限模型。
