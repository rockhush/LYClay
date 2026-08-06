# 变更：LYClaw ELK 软失败 Notice 与后端卡死上报

## 为什么

`lyclaw-elk-log` 的 P0 快照采集入口只覆盖 Gateway `agent` notification 的 `lifecycle/error` phase。但 OpenClaw runtime 还有两类阻碍用户使用的 blocking 失败没有进入快照链路：

1. runtime 通过 `agent` notification 的 `final` stream 下发的"软失败" assistant message content，例如 `⚠️ Agent failed before reply: ...`、`All models failed (...)`、`Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.`。这些 content 不走 `lifecycle/error` phase，当前 Main 侧无任何识别或采集。
2. Renderer 侧判定的"后端 Agent 服务已停止响应"（`backendRunStopped`，`chat.ts:5394`）。当用户发起新消息时发现当前 session 仍存在 `hasTrackedUserRun` 且 abort 后仍未释放，Renderer 直接设置该错误并结束发送；该 run 静默卡死，runtime 既未下发 `lifecycle/error` 也未下发软失败 content，Main 完全感知不到。

本变更在不动 `sessions.abort`/`aborted` 准入原则的前提下，补齐这两类 blocking P0 的快照采集，使研发在 Kibana 能看到这两类用户可见中断的排障快照。

## 改什么

- 扩展 `electron/utils/log-observability.ts` 的 `observeGatewayNotificationForLog`，在 `notification.method === 'agent'` 且 `stream === 'final'` 时，从 `data.message.content` 识别 runtime 软失败 notice，命中则生成与 `lifecycle/error` 共享 `eventName = chat.run_error`、`errorCode = CHAT_RUN_ERROR` 的 blocking P0 快照。因 fingerprint 基于 `eventName + errorCode + method + route + session identity`，同一 run 若同时产生 `lifecycle/error` 与 final 软失败 notice，5 分钟内只生成一条，天然避免重复采集。
- 新增 Main-owned Host API route `POST /api/log/run-failure`，接收 Renderer 上报的 `backendRunStopped` 类 blocking 失败，转交 `captureLogErrorSnapshot`。Renderer 通过 `src/lib/host-api.ts` 调用，不直接 IPC、不直连 ELK。
- 新增软失败 notice 识别函数，覆盖 `Agent failed before reply:`、`All models failed (` 以及包含 `couldn't generate a response` / `generate a response` 关键字的 runtime 软失败 content；与 Renderer 侧 `isEmbeddedAgentFailureNoticeAssistantMessage` 保持一致并扩展。
- `sessions.abort`、`aborted` 状态、用户主动停止仍按原 design 不生成快照，本变更不放宽其准入。

## 影响范围

- 可能涉及：
  - `electron/utils/log-observability.ts`
  - `electron/api/server.ts`
  - `electron/api/routes/log.ts`
  - `electron/main/index.ts`
  - `src/lib/host-api.ts`
  - `src/stores/chat.ts`
- 实现触碰 backend communication 路径（renderer→Main 上报、Gateway notification 采集），实施前新增 harness task spec 并引用 `gateway-backend-communication`。
- 用户可见行为不变化；当 run 产生软失败 notice 或后端卡死时，研发侧获得远端排障快照。
- 明确工具类调用失败（`Write failed`、`Nodes failed`、`Apply Patch failed`、`Message failed`、`Cron failed`、`Exec failed`、`Canvas failed`、`Dir List: ... failed` 等 tool result `isError = true` 或 tool-run-registry `failed`/`timeout`/`kill_failed`）归为 P1：不生成 `error_snapshot`、不写入 snapshot spool、不转发 ELK，只在本地 recent-events buffer 或 regular log 记录用于排障关联。
- `sessions.abort`、`aborted` 状态、用户主动停止仍按原 design 不生成快照，本变更不放宽其准入。
- 实施后按文档同步规则检查 `README.md`、`README.zh-CN.md`、`README.ja-JP.md`。
