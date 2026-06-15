---
id: close-electron-main-shell-entrypoints
title: 收口 Electron Main 本地命令执行入口
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 对 electron/** 运行时代码中的 spawn/exec/execFile/fork 等本地命令执行入口做全量清单、分类和收口，确保动态命令走 command-policy，可信内部维护命令走 trusted-internal-command，并用静态测试阻止新增裸入口。
touchedAreas:
  - electron/security/trusted-internal-command.ts
  - electron/security/command-policy.ts
  - electron/security/policy-engine.ts
  - electron/gateway/process-launcher.ts
  - electron/gateway/supervisor.ts
  - electron/gateway/clawhub.ts
  - electron/extensions/builtin/company-marketplace.ts
  - electron/utils/openclaw-cli.ts
  - electron/utils/openclaw-doctor.ts
  - electron/utils/uv-setup.ts
  - electron/utils/channel-config.ts
  - electron/utils/dws-auth.ts
  - electron/utils/dws-env-setup.ts
  - electron/utils/dws-cli-installer.ts
  - electron/utils/bundled-node.ts
  - electron/utils/gemini-cli-oauth.ts
  - electron/main/updater.ts
  - electron/main/ipc-handlers.ts
  - tests/unit/electron-main-shell-boundary.test.ts
  - tests/unit/security-trusted-internal-command.test.ts
  - tests/unit/security-command-policy.test.ts
  - harness/specs/tasks/close-electron-main-shell-entrypoints.md
expectedUserBehavior:
  - Gateway 启动、Doctor、更新、DWS/OAuth/CLI 安装检测等现有功能保持可用。
  - Agent 或 Gateway runtime 发起的动态命令仍按风险弹出确认或阻断。
  - LYClaw 内部固定维护命令不再打扰用户，但必须经过可信内部命令边界和审计。
  - 新增裸 child_process 入口会被单元测试拦截，要求先归类后接入安全边界。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/close-electron-main-shell-entrypoints.md
  - pnpm exec vitest run tests/unit/electron-main-shell-boundary.test.ts tests/unit/security-trusted-internal-command.test.ts tests/unit/security-command-policy.test.ts
acceptance:
  - electron/** 中所有 child_process.spawn/exec/execFile/fork/execSync/spawnSync 入口都有明确分类。
  - 动态命令入口必须调用 command-policy 或 policy-engine，并产生 allow/prompt/deny 决策。
  - 可信内部维护命令必须调用 trusted-internal-command，并记录 internal-command 审计事件。
  - Electron 运行时代码不得新增裸 execSync shell 字符串入口。
  - 固定启动器例外必须在静态测试 allowlist 中写明原因，不能作为任意 shell 通道。
  - 新增 tests/unit/electron-main-shell-boundary.test.ts，默认禁止未登记的裸 child_process 入口。
docs:
  required: false
---

# 收口 Electron Main 本地命令执行入口

## 对应表格项

- 命令安全 / 所有 shell IPC 接入
- 命令安全 / Main 命令入口接入
- 审计日志 / 命令审计
- 文件路径安全 / execute 策略

这一阶段只收口 `electron/**` 运行时代码，不处理构建脚本、测试脚本、OS 沙箱、OpenClaw 内部实现。

## 范围内入口

需要扫描和分类：

```text
child_process.spawn
child_process.exec
child_process.execFile
child_process.fork
child_process.execSync
child_process.spawnSync
utilityProcess.fork
cmd.exe
powershell / pwsh
npm / pnpm / node / python / uv / dws / openclaw 动态启动
```

## 分类规则

### A. 可信内部维护命令

特点：

```text
命令来源由 LYClaw 固定
参数不可由 Agent/Skill/MCP/Renderer 任意拼接
用于 Gateway 启动、端口清理、doctor repair、CLI 检测、安装器辅助等内部维护动作
```

处理方式：

```text
走 trusted-internal-command
记录 internal-command 审计事件
不弹用户确认，避免启动/修复流程被打断
```

### B. 动态命令

特点：

```text
命令或参数来自 Agent/Gateway runtime/用户输入/外部配置
可能读写文件、联网、删除、安装依赖、执行脚本
```

处理方式：

```text
走 command-policy 或 policy-engine
allow/prompt/deny 都要审计
prompt 时进入安全确认弹窗
```

### C. 固定启动器例外

特点：

```text
必须使用底层 spawn/fork 才能启动固定进程
命令路径和参数有严格来源约束
不是任意 shell 通道
```

处理方式：

```text
允许保留底层 child_process/utilityProcess 调用
必须写入静态测试 allowlist
allowlist 备注说明为什么安全、由谁约束参数
```

## 当前初始扫描结果

初始扫描命令：

```bash
rg -n 'child_process|node:child_process|spawn\(|exec\(|execFile\(|fork\(|cmd\.exe|powershell|pwsh' electron -g '*.ts'
```

已发现的主要入口：

```text
electron/utils/openclaw-cli.ts
electron/utils/channel-config.ts
electron/utils/uv-setup.ts
electron/utils/token-storage.ts
electron/utils/bundled-node.ts
electron/utils/dws-env-setup.ts
electron/utils/dws-cli-installer.ts
electron/utils/gemini-cli-oauth.ts
electron/utils/openclaw-doctor.ts
electron/utils/dws-auth.ts
electron/gateway/process-launcher.ts
electron/gateway/clawhub.ts
electron/gateway/supervisor.ts
electron/extensions/builtin/company-marketplace.ts
electron/main/updater.ts
electron/main/ipc-handlers.ts（Skill ZIP 解压已改为应用内 manualExtractZip，不再保留外部解压命令入口）
```

## 建议实施顺序

1. 新增 `tests/unit/electron-main-shell-boundary.test.ts`。
2. 把当前扫描结果整理成 allowlist，每项必须带分类和说明。
3. 先让测试失败，暴露所有未分类入口。
4. 逐个入口处理：
   - 已安全接入的，加入 allowlist 并注明安全边界。
   - 可信内部维护命令，补 `trusted-internal-command`。
   - 动态命令，补 `command-policy` / `policy-engine`。
   - 能改成参数数组或应用内实现的，移除 shell 字符串拼接。
5. 最后收紧测试，禁止新增未登记入口和裸 execSync。

## 完成后表格填写

完成本 spec 后，表格建议更新为：

```text
命令安全 / 所有 shell IPC 接入：已实现
备注：Electron Main 运行时代码中的 shell/spawn/exec/execFile/fork 入口已完成扫描和收口；可信内部命令走 trusted-internal-command；动态命令走 command-policy；新增静态测试防止新增裸入口。

命令安全 / Main 命令入口接入：部分实现
备注：Electron Main 本地命令入口已收口；后续仅剩 OpenClaw runtime 内部或非 Electron 范围入口。

审计日志 / 命令审计：部分实现
备注：Electron Main 收口入口已进入 internal-command 或 command-policy 审计链路；非 Electron 旧链路后续治理。
```

## 验证命令

```bash
pnpm harness validate --spec harness/specs/tasks/close-electron-main-shell-entrypoints.md
pnpm exec vitest run tests/unit/electron-main-shell-boundary.test.ts tests/unit/security-trusted-internal-command.test.ts tests/unit/security-command-policy.test.ts
pnpm run build:vite
```
