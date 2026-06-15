---
id: audit-and-integrate-shell-ipc-entrypoints
title: 收口本地 shell IPC 与进程启动入口
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 盘点 Main 进程中的本地命令入口，并将 Agent 删除后的 Gateway 清理从路由层裸 shell 命令迁移到受控的 Gateway supervisor 边界。
touchedAreas:
  - electron/api/routes/agents.ts
  - electron/gateway/supervisor.ts
  - tests/unit/agents-routes.test.ts
  - tests/unit/gateway-supervisor.test.ts
  - harness/specs/tasks/audit-and-integrate-shell-ipc-entrypoints.md
expectedUserBehavior:
  - 删除 Agent 后 Gateway 仍会完整重启，避免旧通道连接残留。
  - 路由层不再直接执行 taskkill、netstat 或 lsof。
  - Gateway 进程和端口清理由 supervisor 统一校验和审计。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/audit-and-integrate-shell-ipc-entrypoints.md
  - pnpm exec vitest run tests/unit/agents-routes.test.ts tests/unit/gateway-supervisor.test.ts tests/unit/security-trusted-internal-command.test.ts
acceptance:
  - Agent 删除后的 Gateway PID 清理调用 terminateGatewayProcessByPid。
  - Agent 删除后的 Gateway 端口清理调用 terminateGatewayListenersOnPort。
  - Windows taskkill 和 listener query 仍经过 trusted-internal-command 校验。
  - spec 中记录后续仍需逐项确认的进程启动入口。
docs:
  required: true
---

# 收口本地 shell IPC / 进程启动入口

## 背景

本任务对应安全表格：

- 第 39 行：命令安全 / Main 命令入口接入
- 第 41 行：命令安全 / 所有 shell IPC 接入
- 第 76 行：审计日志 / 命令审计

LYClaw 中存在多类本地命令入口：

- Agent / Gateway runtime 动态命令：必须走 `command-policy` 和用户确认。
- LYClaw 固定内部维护命令：必须走 `trusted-internal-command`，不能由 Renderer/Agent 伪造。
- 安装器、OAuth、更新器等应用能力命令：需要逐项分类，不能裸露为任意 shell。

本阶段先完成入口盘点，并补齐已发现的高风险绕过口。

## 已盘点入口

### 已接入 command-policy

- `electron/gateway/exec-approval-bridge.ts`
- `electron/gateway/clawhub.ts`
- `electron/extensions/builtin/company-marketplace.ts`
- `electron/utils/channel-config.ts`
- `electron/utils/openclaw-doctor.ts`
- `electron/utils/uv-setup.ts`

### 已接入 trusted-internal-command

- `electron/gateway/process-launcher.ts`
- `electron/gateway/supervisor.ts`
- `electron/api/routes/agents.ts` 的 Agent 删除后 Gateway 强制重启清理

### 本阶段补齐

- `electron/api/routes/agents.ts`
  - 删除 Agent 后不再直接拼接 `taskkill`、`netstat`、`lsof`。
  - 路由层改为调用 `terminateGatewayProcessByPid` / `terminateGatewayListenersOnPort`。
  - 实际 shell 命令统一下沉到 `electron/gateway/supervisor.ts`，并通过 `trusted-internal-command` 校验和审计。

### 后续仍需逐项确认

- `electron/utils/dws-auth.ts`
- `electron/utils/dws-env-setup.ts`
- `electron/utils/dws-cli-installer.ts`
- `electron/utils/bundled-node.ts`
- `electron/utils/gemini-cli-oauth.ts`
- `electron/utils/openclaw-cli.ts`
- `electron/main/updater.ts`
- `electron/utils/token-storage.ts`

这些入口不在本阶段一次性改完，后续需要按“应用固定命令 / 用户触发命令 / 外部工具命令”继续拆分。

## 验收标准

- Agent 删除后的 Gateway 重启清理不再直接调用裸 `child_process.exec`。
- Gateway PID / 端口清理由 `supervisor` 统一执行。
- Windows `taskkill`、`netstat` 相关清理必须经过 `assertTrustedInternalCommand`。
- 已补齐入口有单元测试覆盖。
- 规格文档明确后续仍未收口的入口。

## 验证命令

```bash
pnpm harness validate --spec harness/specs/tasks/audit-and-integrate-shell-ipc-entrypoints.md
pnpm exec vitest run tests/unit/agents-routes.test.ts tests/unit/gateway-supervisor.test.ts tests/unit/security-trusted-internal-command.test.ts
```
