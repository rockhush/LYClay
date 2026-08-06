# 设计：LYClaw ELK 软失败 Notice 与后端卡死上报

## 概览

本变更在 `lyclaw-elk-log` 已有的 P0 快照管线上，补齐两类当前未采集的 blocking 失败：

1. runtime 经 `agent` notification `final` stream 下发的软失败 assistant message content。
2. Renderer 判定的后端 Agent 卡死（`backendRunStopped`）。

两者都阻碍用户当前使用，符合 P0 blocking 定义。采集仍走 Main 进程的 `captureLogErrorSnapshot`，复用既有脱敏、入队、磁盘 spool 和 TCP 转发链路，不新增网络出口或 Renderer 直连路径。

## 软失败 Notice 识别

runtime 在 `final` stream 通过 `data.message.content` 下发软失败 notice。Renderer 侧已有 `isEmbeddedAgentFailureNoticeAssistantMessage`（`src/stores/chat/run-lifecycle.ts`）识别 `Agent failed before reply:` 与 `All models failed (`。本变更在 Main 侧新增等价识别函数 `isRuntimeSoftFailureNotice(content)`，并扩展覆盖包含 `generate a response` 关键字的 content（对应 `Agent couldn't generate a response...`）。

识别规则（大小写不敏感）：

- 以 `⚠️? Agent failed before reply:` 开头；
- 以 `All models failed (` 开头；
- 包含 `couldn't generate a response` 或 `generate a response` 且 message role 为 assistant。

匹配命中后在 `observeGatewayNotificationForLog` 内复用既有 `pipeline.captureSnapshot` 调用，字段映射：

| 快照字段 | 取值 |
|---------|------|
| `eventName` | `chat.run_error` |
| `errorCode` | `CHAT_RUN_ERROR` |
| `operationKind` | `user_chat` |
| `failureStage` | `agent_message_failure` |
| `source` | `chat` |
| `message` | 已脱敏 content |
| `runId` / `sessionKey` | notification params |
| `metadata.stream` | `final` |

## 与 lifecycle/error 去重

fingerprint = SHA256(`[eventName, errorCode, method, route, sessionIdentity]`）。软失败 notice 与 `lifecycle/error` 路径共用 `eventName = chat.run_error`、`errorCode = CHAT_RUN_ERROR`，且 `method`/`route` 均为空，`sessionIdentity` 取自同一 run。因此同一 run 若同时产生两者，5 分钟内只生成一条快照，后续命中只累计 `occurrenceCount`。这天然避免了同一 run 的重复采集，无需跨入口状态协调。

## Renderer 后端卡死上报

`backendRunStopped` 在 `chat.ts:5394` 由 Renderer 判定：用户发起新消息时 `refreshSessionBackendActivity` 发现 `hasTrackedUserRun` 仍为 true，`abortGatewayRun` 后仍未释放。该 run 静默卡死，runtime 未下发 `lifecycle/error` 或软失败 content，Main 无法感知。

### Host API route

新增 `POST /api/log/run-failure`，在 `electron/api/routes/log.ts` 注册，复用 `parseJsonBody` 与 `HostApiContext`。请求体：

```json
{ "runId": "string|null", "sessionKey": "string", "errorCode": "BACKEND_RUN_STOPPED", "message": "string", "metadata": {} }
```

处理流程：

1. 校验 `sessionKey` 非空；缺失则返回 200 但不采集（避免 Renderer 重试）。
2. 调用 `captureLogErrorSnapshot`，字段映射如下表。
3. 路由返回 `{ success: true }`，不等待落盘或转发。

| 快照字段 | 取值 |
|---------|------|
| `eventName` | `chat.run_error` |
| `errorCode` | `CHAT_RUN_ERROR`（上报 payload 的 errorCode 仅用于 metadata） |
| `operationKind` | `user_chat` |
| `failureStage` | `backend_run_stuck` |
| `source` | `chat` |
| `message` | payload.message |
| `runId` / `sessionKey` | payload |
| `metadata.reportedErrorCode` | payload.errorCode |

### Renderer 集成

在 `src/lib/host-api.ts` 新增 `reportRunFailureSnapshot(payload)`，走既有 `hostApiFetch` POST。`chat.ts` 在设置 `backendRunStopped` 错误时 fire-and-forget 调用，`runId` 取 `preSendActivity.session.activeRunIds[0]`。调用失败只 `console.warn`，不影响 `sending` 状态。

## 不变项

- `sessions.abort`、`aborted` 状态、用户主动停止仍按原 design 不生成快照。
- Renderer 不直连 ELK、Gateway HTTP 或直接 IPC 日志投递。
- 快照脱敏、磁盘 spool、TCP 转发、退避和失败隔离规则不变。
- 网络出口仍只有 Main 进程 TCP `10.0.1.62:5213`。

## 工具类调用失败的 P1 归类

OpenClaw runtime 的工具调用失败（tool result `isError = true`，或 `tool-run-registry` 的 `failed`/`timeout`/`kill_failed` 终态）不属于阻碍用户当前使用的 blocking P0。典型表现：

- 文件操作：`Write failed`、`Dir List: ~/.openclaw/skills failed`
- 代码/补丁：`Apply Patch failed`
- 命令执行：`Exec failed`
- 子任务/节点：`Nodes failed`
- 消息投递：`Message failed`
- 定时任务：`Cron failed`
- 画布/其他：`Canvas failed`

这些失败：

- 是 run 内部局部失败，run 本身仍可继续或由 runtime 自行重试/降级；
- 不携带 `operationKind`/`failureStage` 这类"被阻断的用户操作 + 失败阶段"语义；
- 量大且同质化，若进 ELK 会淹没真正的 P0 故障。

因此明确归为 P1，但与原 `lyclaw-elk-log` design 不同的是：**P1 也采集、落盘并转发 ELK**，只是优先级低于 P0。

P1 处理规则：

- 通过 `observeGatewayNotificationForLog` 在 `item`/`final` stream 识别 tool-role + `isError=true` 或 content 以 `failed` 结尾/含 `failed:` 的 tool result，调用 `captureLogErrorSnapshot` 生成 `priority=p1`、`userImpact=non-blocking`、`operationKind=app_runtime`、`failureStage=tool_execution` 的 P1 快照。
- P1 准入不要求 `userImpact=blocking`；`hasAdmission` 接受 `priority=p1` + `operationKind` + `failureStage`。
- P1 落盘走 `scheduleWriter` 的 P1 分支：空闲 5 秒（`writerDelayMs`）延迟调度，不抢占 P0；spool 保留超限时优先保留 P0，再压缩或丢弃 P1。
- P1 转发：`isElkEligibleSnapshot` 接受 `p0` 与 `p1`（`userImpact` 为 `blocking` 或 `non-blocking`）；`LogForwarder` 批次按 `sortSnapshots` 保证 P0 先于 P1 写入 TCP，P1 紧随其后，网络失败两者都保留 spool 并按既有退避重试。
- `tool-run-registry` 现有 `logger.warn` 诊断保持不变；P1 快照由 notification 路径采集，不依赖 registry。
- 非用户 run（后台 agent/warmup/cron）的 tool failure 不采集。

与 run 级 P0 的关系：工具失败（P1）与 run 级 `lifecycle/error`（P0）fingerprint 不同（P1 `eventName=chat.tool_failure`，P0 `eventName=chat.run_error`），不互相去重，各自独立采集。只有 run 整体进入 `lifecycle/error`、`final` 软失败 notice 或 Renderer 判定 `backendRunStopped` 时才按对应入口判 P0。
