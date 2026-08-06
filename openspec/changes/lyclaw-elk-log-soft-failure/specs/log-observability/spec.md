## ADDED Requirements

### Requirement: Runtime 软失败 Notice 快照采集

LYClaw MUST 在 `agent` notification 的 `final` stream 上识别 runtime 软失败 notice content，并生成与 `lifecycle/error` 路径共享 `eventName = chat.run_error`、`errorCode = CHAT_RUN_ERROR` 的 blocking P0 快照。

#### Scenario: 识别 final stream 软失败 notice

- **WHEN** Gateway 下发 `method = agent` 且 `stream = final` 的 notification
- **AND** `data.message.content` 命中软失败 notice 模式（`Agent failed before reply:`、`All models failed (` 或包含 `generate a response` 关键字）
- **AND** 该 runId 属于已跟踪的用户 chat run
- **THEN** LYClaw MUST 生成一条 `userImpact = blocking`、`operationKind = user_chat`、`failureStage = agent_message_failure` 的 P0 快照
- **AND** `eventName` 必须为 `chat.run_error`
- **AND** `errorCode` 必须为 `CHAT_RUN_ERROR`
- **AND** `message` 必须为已脱敏的 runtime content 文本
- **AND** `runId`、`sessionKey` 必须来自 notification params。

#### Scenario: 与 lifecycle/error 共享 fingerprint 去重

- **WHEN** 同一 run 既产生 `lifecycle/error` 又产生 final 软失败 notice
- **THEN** 因 fingerprint 基于 `eventName + errorCode + method + route + session identity`
- **AND** 两者 `eventName` 与 `errorCode` 相同
- **AND** 5 分钟内只生成一条快照
- **AND** 后续命中只累计 `occurrenceCount` 不重复落盘或发送。

#### Scenario: 非软失败 final content 不采集

- **WHEN** `final` stream 的 `data.message.content` 不命中软失败 notice 模式
- **THEN** LYClaw MUST NOT 生成快照
- **AND** 不得阻塞该 message 的正常分发。

#### Scenario: 非用户 run 的软失败 notice 不采集

- **WHEN** 软失败 notice 来自后台 agent、warmup 或 cron run
- **THEN** LYClaw MUST NOT 生成快照
- **AND** 该 message 可正常分发。

### Requirement: Renderer 后端卡死失败上报

LYClaw MUST 通过 Main-owned Host API route 接收 Renderer 上报的后端卡死类 blocking 失败，并生成 blocking P0 快照；Renderer 不得直接调用 ELK 或直接 IPC。

#### Scenario: Renderer 上报 backendRunStopped

- **WHEN** Renderer 判定当前 session 仍存在 `hasTrackedUserRun` 且 abort 后仍未释放
- **AND** 通过 `src/lib/host-api.ts` 调用 `POST /api/log/run-failure`
- **THEN** Main 进程 MUST 调用 `captureLogErrorSnapshot` 生成一条 `userImpact = blocking`、`operationKind = user_chat`、`failureStage = backend_run_stuck` 的 P0 快照
- **AND** `eventName` 必须为 `chat.run_error`
- **AND** `errorCode` 必须为 `CHAT_RUN_ERROR`
- **AND** `sessionKey` 与 `runId`（若有）必须来自上报 payload
- **AND** 上报失败不得阻塞 Renderer 主流程或抛出未捕获异常。

#### Scenario: Renderer 不直连日志后端

- **WHEN** Renderer 需要上报后端卡死失败
- **THEN** 必须通过 Main-owned Host API route
- **AND** MUST NOT 直接调用 ELK TCP、内网日志服务或用于快照投递的直接 IPC channel。

#### Scenario: 缺失必要字段的上报不采集

- **WHEN** 上报 payload 缺少 `sessionKey` 或 `operationKind`/`failureStage` 未满足 blocking 准入
- **THEN** Main MUST NOT 生成快照
- **AND** 路由仍返回 200 以免 Renderer 重试阻塞。

### Requirement: 工具类调用失败作为 P1 采集并转发

LYClaw MUST 将工具类调用失败（tool execution failures）采集为 P1 `error_snapshot` 快照，落盘到本地 spool 并转发到 ELK，但优先级低于 P0：P0 立即落盘并转发，P1 按批量/空闲调度，P0 抢占 P1。

#### Scenario: 工具执行失败生成 P1 快照并转发

- **WHEN** runtime 下发的 tool result 携带 `isError = true`，或 tool-run-registry 将 tool 标记为 `failed`/`timeout`/`kill_failed`
- **AND** 失败表现为工具调用错误内容，例如 `Write failed`、`Nodes failed`、`Apply Patch failed`、`Message failed`、`Cron failed`、`Exec failed`、`Canvas failed`、`Dir List: ... failed`
- **AND** 该 tool result 属于已跟踪的用户 chat run
- **THEN** LYClaw MUST 生成一条 `priority = p1` 的 `error_snapshot` 快照
- **AND** `userImpact` 必须为空或非 `blocking`（P1 不占用 blocking 准入）
- **AND** `operationKind` 必须为 `app_runtime`
- **AND** 必须落盘到 snapshot spool 并按 P1 调度转发到 ELK TCP `10.0.1.62:5213`
- **AND** 转发批次中 P0 必须先于 P1。

#### Scenario: P1 落盘调度

- **WHEN** P1 快照入队
- **THEN** LYClaw 必须按空闲 5 秒、达 50 条或 256KB、最旧等待 60 秒调度落盘
- **AND** 若同时有 P0 等待，P1 必须延后
- **AND** spool 保留超限时优先保留 P0，再压缩或丢弃 P1。

#### Scenario: P1 转发与 P0 抢占

- **WHEN** 一批未确认快照同时含 P0 与 P1
- **THEN** `LogForwarder` 必须将两者都加入发送批次
- **AND** P0 必须先于 P1 写入 TCP
- **AND** 网络失败时两者都保留 spool 并按既有退避重试。

#### Scenario: 非用户 run 的工具失败不采集

- **WHEN** 工具失败来自后台 agent、warmup 或 cron run
- **THEN** LYClaw MUST NOT 生成快照。

#### Scenario: 工具失败与 run 级失败同时存在

- **WHEN** run 既产生工具调用失败又触发 run 级 lifecycle/error
- **THEN** 工具失败按 P1、run 级失败按 P0 各自独立判定
- **AND** 两者 fingerprint 不同（P1 eventName 与 P0 不同），不互相去重。
