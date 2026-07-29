
## ADDED Requirements

### Requirement: Main 进程拥有错误快照管线

LYClaw MUST 只在 Electron Main 进程中生成、脱敏、入队、落盘和转发 ELK 错误快照。

#### Scenario: Renderer 上报错误

- **WHEN** Renderer 发生崩溃或 ErrorBoundary 错误
- **THEN** Renderer 必须通过 Main-owned route 上报该错误
- **AND** Renderer 不得直接调用 ELK、内网日志服务、Gateway HTTP 日志端点或用于快照投递的直接 IPC。

#### Scenario: 业务流程捕获失败

- **WHEN** Main 代码调用 `captureErrorSnapshot(...)`
- **THEN** 该调用只能执行轻量校验、脱敏和入队
- **AND** 不得等待磁盘写入
- **AND** 不得等待 ELK 网络请求。

### Requirement: 错误快照 Schema

ELK-bound 快照文档 MUST 使用 `documentType = "error_snapshot"` 和 `schemaVersion = 1`。

#### Scenario: 创建 ELK-bound 快照

- **WHEN** 捕获显式声明 `userImpact = "blocking"` 的 P0 失败
- **THEN** 快照必须包含 `snapshotId`、`ts`、`priority`、`userImpact`、`operationKind`、`failureStage`、`fingerprint`、`occurrenceCount`、`firstSeenAt`、`lastSeenAt`、`level`、`source`、`eventName`、`component`、`errorCode`、`message`、`workNo`、`userName`、`identityMissingReason`、`requestId`、`runId`、`modelId`、`baseUrl`、`method`、`route`、`status`、`statusCode`、`durationMs`、`retryCount`、`fallbackUsed`、`recovered`、`recentEvents`、`metadata`、`truncated`
- **AND** `priority` 必须是 `p0`
- **AND** `userImpact` 必须是 `blocking`
- **AND** `level` 必须是 `error` 或 `warn`。

#### Scenario: 快照写入本地 JSONL

- **WHEN** `SnapshotSpoolWriter` 将快照写入 `logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.jsonl`
- **THEN** 每一行必须是一条完整 `error_snapshot` JSON 文档
- **AND** 该 JSON 文档必须包含 schema 要求的完整字段集合
- **AND** ack 文件不得替代或重建 snapshot JSONL 内容。

#### Scenario: 身份不可用

- **WHEN** 无法获取钉钉工号或用户名
- **THEN** `workNo` 和 `userName` 仍必须以字符串字段存在
- **AND** 缺失值必须为空字符串
- **AND** LYClaw 必须记录已脱敏的身份缺失原因。

#### Scenario: 创建模型链路快照

- **WHEN** 失败属于 Chat、Gateway RPC、Provider 或模型请求链路
- **THEN** 快照必须包含当前链路可获得的 `sessionKey`、`modelId` 和 `baseUrl`
- **AND** `sessionKey` 必须保存原始 OpenClaw runtime session key
- **AND** 解析成功时 `sessionId` 必须保存对应 transcript 文件名 UUID
- **AND** `baseUrl` 只能包含协议、host 和基础路径。

### Requirement: Transcript 会话标识解析

LYClaw MUST 将错误快照顶层 `sessionId` 定义为 transcript 文件名 UUID，并将原始 OpenClaw runtime session key 保存为顶层 `sessionKey`。

#### Scenario: 从 sessionFile 解析 UUID

- **WHEN** 快照输入包含 `agent:<agentId>:...` 格式的 `sessionKey`
- **AND** `agents/<agentId>/sessions/sessions.json` 的同 key 条目包含可解析 transcript UUID 的 `sessionFile`
- **THEN** LYClaw 必须将该 UUID 写入快照顶层 `sessionId`
- **AND** 将原始 key 写入顶层 `sessionKey`
- **AND** 必须支持普通、`.deleted.jsonl` 和 `.jsonl.reset.*` transcript 文件名。

#### Scenario: 使用索引字段回退解析

- **WHEN** `sessionFile` 不存在或未包含合法 UUID
- **THEN** LYClaw 必须依次检查索引条目的 `sessionId` 和 `id`
- **AND** 使用第一个合法 UUID 作为快照顶层 `sessionId`。

#### Scenario: 会话 UUID 无法解析

- **WHEN** session key 格式不合法、索引文件不存在或不可读、索引条目缺失，或 `sessionFile`、`sessionId`、`id` 均不包含合法 UUID
- **THEN** LYClaw 必须保留可获得的顶层 `sessionKey`
- **AND** 必须省略顶层 `sessionId`
- **AND** 不得将 runtime session key 回填到 `sessionId`
- **AND** 映射失败不得阻止快照生成、落盘、转发或用户主流程。

#### Scenario: 不同 Agent 的同名会话

- **WHEN** 两个不同 agent 的 session key 具有相同尾部片段
- **THEN** LYClaw 必须只读取 session key 中对应 agentId 的 `sessions/sessions.json`
- **AND** 不得跨 agent 解析 transcript UUID。

### Requirement: 快照脱敏

LYClaw MUST 在数据进入快照内存队列、磁盘 spool 或远端发送前完成敏感内容脱敏。

#### Scenario: 快照数据包含敏感内容

- **WHEN** message、URL、path、metadata 或 recent event 被加入快照
- **THEN** 不得包含 Prompt 正文、模型响应正文、Transcript 正文、文件内容、Provider Key、Bearer Token、OAuth Code、DWS Token 或凭据
- **AND** URL 不得包含 query string、token、key 或 credential
- **AND** 文件系统字段不得暴露敏感完整路径或文件内容。

### Requirement: Recent Events 上下文

LYClaw MUST 在 Main 进程维护已脱敏的 `recentEventsBuffer`，用于快照上下文。

#### Scenario: 快照收集上下文

- **WHEN** 组装快照
- **THEN** 必须考虑错误发生前 30 秒内的事件
- **AND** 必须优先保留相同 `requestId`、`runId`、runtime session key 或 `modelId/baseUrl` 的事件
- **AND** recent event 的 `sessionId` 必须继续保存 runtime session key，用于现有事件关联
- **AND** 快照组装必须使用顶层 `sessionKey` 收集相关事件，不得使用 transcript UUID 替代该关联键
- **AND** `recentEvents` 最多包含 50 条。

#### Scenario: P0 等待错误后上下文

- **WHEN** 捕获 P0 快照
- **THEN** LYClaw 可以等待最多 5 秒收集恢复或追加失败事件
- **AND** 该等待不得阻塞用户可见的失败流程。

#### Scenario: 快照超过大小限制

- **WHEN** 序列化后的快照会超过 64KB
- **THEN** LYClaw 必须截断 `recentEvents`
- **AND** 设置 `truncated = true`。

### Requirement: ELK 严重错误准入

LYClaw MUST 只为阻碍用户当前使用且未恢复的 P0 失败创建 ELK-bound 快照。采集入口未显式声明 `userImpact = "blocking"` 时 MUST 默认拒绝生成快照。

#### Scenario: 当前流程不可用

- **WHEN** 当前程序、当前聊天会话、当前选中模型、Gateway 传输、阻断型工具运行或当前模型下游路径不可用，且自动恢复、fallback 或重试无法恢复
- **THEN** LYClaw 必须将该失败归类为 P0
- **AND** 创建 `error_snapshot`。

#### Scenario: 后台或可恢复失败

- **WHEN** Chat、Gateway、Host API、security、channel、agent、plugin、skill、Provider、OAuth、Sub2API、DWS、钉钉、用量上报、系统依赖或工具失败是可恢复、局部、后台、非当前链路或审计型问题
- **THEN** LYClaw MUST NOT 创建、落盘或发送 `error_snapshot`
- **AND** 可以继续写入本地 regular log、recent-events buffer 或独立审计日志。

#### Scenario: 安全事件

- **WHEN** 安全策略正常 deny、风险为 high/critical 或安全审计记录成功
- **THEN** LYClaw MUST NOT 创建、落盘或发送 ELK `error_snapshot`。

#### Scenario: 非阻断 Gateway RPC 失败

- **WHEN** `sessions.abort`、`skills.status`、warmup、后台恢复、轮询或其他未声明 blocking 的 Gateway RPC 失败
- **THEN** LYClaw MUST NOT 创建、落盘或发送 ELK `error_snapshot`。

#### Scenario: 当前用户 Chat run 最终失败

- **WHEN** Main 能确认失败的 lifecycle 事件属于已跟踪的当前用户 Chat run
- **AND** 该运行未通过 fallback 或恢复产生可见结果
- **THEN** LYClaw MUST 创建 `userImpact = "blocking"`、`operationKind = "user_chat"` 的 P0 快照。

#### Scenario: 后台 Agent run 失败

- **WHEN** lifecycle error 属于 warmup、cron、后台 agent、内部反馈或无法确认属于当前用户的 run
- **THEN** LYClaw MUST NOT 创建、落盘或发送 ELK `error_snapshot`。

#### Scenario: Host API 最终失败

- **WHEN** Host API 服务端处理当前请求时最终返回 5xx 或抛出异常
- **THEN** LYClaw MUST 创建一次 blocking P0 快照
- **AND** `hostapi:fetch` 代理层 MUST NOT 为相同 HTTP 5xx 再创建快照。

#### Scenario: Chat timeout 后恢复

- **WHEN** `chat.send` ack timeout 后，Gateway 事件或 transcript fallback 最终产生可见进展或 final
- **THEN** LYClaw 不得将该事件归类为 P0
- **AND** MUST NOT 创建或发送 ELK `error_snapshot`。

#### Scenario: Chat ack timeout 结果未知

- **WHEN** 当前用户 `chat.send` 发生 ack timeout，但 Main 尚未收到可精确关联的最终失败 lifecycle 事件
- **THEN** LYClaw MUST 只记录 timeout recent event
- **AND** MUST NOT 在 timeout 当下创建或发送 ELK `error_snapshot`
- **AND** 后续只有携带 `runId` 且属于已跟踪当前用户 Chat run 的 lifecycle error 才能创建 P0 快照。

### Requirement: 严重错误指纹合并

LYClaw MUST 在入队前按稳定 fingerprint 合并重复的 blocking P0 错误。

#### Scenario: 首次发生

- **WHEN** 某 fingerprint 在当前进程中首次出现
- **THEN** LYClaw MUST 立即生成快照
- **AND** 设置 `occurrenceCount = 1`、`firstSeenAt = lastSeenAt`。

#### Scenario: 五分钟内重复

- **WHEN** 同一 `eventName + errorCode + method + route + session identity` fingerprint 在上次上传后 5 分钟内再次发生
- **THEN** LYClaw MUST 只增加内存累计次数并更新 `lastSeenAt`
- **AND** MUST NOT 生成、落盘或发送重复快照。

#### Scenario: 指纹选择会话标识

- **WHEN** LYClaw 为 blocking P0 错误生成 fingerprint
- **THEN** session identity 必须优先使用解析后的 transcript UUID
- **AND** UUID 无法解析时必须回退使用原始 `sessionKey`
- **AND** 不得因会话 UUID 解析失败而跳过 fingerprint 合并。

#### Scenario: 合并窗口结束后再次发生

- **WHEN** 同一 fingerprint 距上次上传已达到 5 分钟并再次发生
- **THEN** LYClaw MUST 生成新快照
- **AND** 携带当前进程内累计 `occurrenceCount`、`firstSeenAt` 和 `lastSeenAt`。

#### Scenario: 聚合状态有界

- **WHEN** fingerprint 状态超过 1000 项
- **THEN** LYClaw MUST 淘汰最久未观察到的项。

### Requirement: 有界写队列

LYClaw MUST 在磁盘 spool 写入前使用有界且有优先级的 `snapshotWriteQueue`。

#### Scenario: 快照进入队列

- **WHEN** P0 快照入队
- **THEN** 它必须进入高优先级队列。

#### Scenario: 非阻断事件准备入队

- **WHEN** P1、缺少 blocking 标记或明确为非阻断的事件准备进入 snapshot 队列
- **THEN** LYClaw MUST 拒绝入队
- **AND** MUST NOT 调度 snapshot writer 或 `LogForwarder`。

#### Scenario: 队列达到压力上限

- **WHEN** 队列将超过 1000 条快照或 8MB
- **THEN** LYClaw 必须丢弃最旧 P0 或压缩其 `recentEvents`
- **AND** 记录本地 `log.pipeline` 诊断。

### Requirement: 快照 Spool 持久化

LYClaw MUST 通过单一 `SnapshotSpoolWriter` 将快照持久化到 append-only JSONL spool 文件。

#### Scenario: 写入快照

- **WHEN** writer drain 已入队快照
- **THEN** 必须向 `logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.jsonl` 按行追加 `error_snapshot` JSON 对象
- **AND** 不得改写已有 snapshot JSONL 内容。

#### Scenario: 更新 Ack 状态

- **WHEN** 已发送快照被确认
- **THEN** LYClaw 必须将 ack 状态写入 `logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.ack.json`
- **AND** ack 必须包含 `file`、`ackedOffset`、`ackedLine`、`lastSnapshotId`、`updatedAt`。

#### Scenario: Spool 超过保留上限

- **WHEN** 本地 snapshot spool 超过 20MB 或最近 7 天
- **THEN** LYClaw 必须优先保留最新的 blocking P0 快照
- **AND** 历史 P1 或缺少 blocking 标记的文件不得因为 retention 而重新进入发送批次。

### Requirement: P0 落盘行为

LYClaw MUST 优先持久化 P0 快照。

#### Scenario: P0 入队

- **WHEN** P0 快照进入写队列
- **THEN** writer 必须在 0-50ms 内被调度
- **AND** writer 只能 drain 已通过 blocking 准入的 P0。

#### Scenario: 应用退出

- **WHEN** LYClaw 正在退出
- **THEN** Main 必须最多等待 1500ms，用于 drain P0 和已开始批次。

#### Scenario: Fatal shutdown

- **WHEN** Main 即将崩溃或无法依赖异步 writer
- **THEN** LYClaw 可以只对当前 P0 快照执行 emergency sync append。

### Requirement: 非阻断事件不落盘

LYClaw MUST NOT 将 P1、后台、审计、清理、可恢复或其他非阻断事件持久化为 snapshot JSONL。

#### Scenario: 后台错误频繁发生

- **WHEN** 后台 Gateway RPC、agent、security 或普通刷新错误频繁发生
- **THEN** snapshot queue 和 spool 数量 MUST NOT 因这些事件增长。

#### Scenario: 本地诊断保留

- **WHEN** 非阻断事件仍有排查价值
- **THEN** LYClaw 可以写入本地 regular log、recent-events buffer 或独立安全审计日志。

### Requirement: 基于磁盘的转发

`LogForwarder` MUST 从已持久化的 snapshot spool 文件读取，且不得直接消费内存队列。

#### Scenario: P0 已落盘

- **WHEN** P0 快照成功 append 到 spool
- **THEN** LYClaw 必须立即调度远端 flush
- **AND** 发送批次只能包含满足 blocking 准入的 P0。

#### Scenario: 历史 P1 不发送

- **WHEN** 网络可达且磁盘存在历史 P1
- **THEN** LYClaw MUST NOT 将其加入远端发送批次
- **AND** 必须在本地 ack 中将其标记为已处理。

#### Scenario: 非阻断历史记录很多

- **WHEN** spool 中存在大量历史 P1 或缺少 blocking 标记的记录
- **THEN** `LogForwarder` 必须在本地批量 ack 后跳过
- **AND** 不得建立只包含这些记录的 ELK TCP 连接。

### Requirement: ELK 可达性和失败隔离

LYClaw MUST 将 ELK 网络失败与 Chat、Gateway、Host API、Provider 等主流程隔离。

#### Scenario: ELK TCP 不可达

- **WHEN** 转发时发生 DNS/内网不可达、连接拒绝、连接或写入 timeout、写入失败或异常关闭
- **THEN** LYClaw 必须保留 spool 中的快照
- **AND** 按 1min、5min、15min、30min 退避重试
- **AND** 退避到期后必须自动调度下一次发送
- **AND** Chat、Gateway、Host API、Provider 主流程不得等待 ELK。

#### Scenario: 网络恢复

- **WHEN** 发送在 unreachable 后成功
- **THEN** LYClaw 必须清空退避
- **AND** 立即调度 flush。

### Requirement: 埋点覆盖

LYClaw MUST 在可能产生 blocking P0 快照的路径上记录已脱敏 recent events。

#### Scenario: 后端通信路径运行

- **WHEN** Host API route、`hostapi:fetch`、`gateway:rpc` 或 `gateway:httpProxy` 成功、失败或慢响应
- **THEN** Main 必须记录已脱敏 recent-event 摘要。

#### Scenario: Runtime 和集成路径失败

- **WHEN** Gateway lifecycle/transport/heartbeat/chat recovery、security audit、Sub2API、DWS、钉钉、Provider、OAuth、模型同步、用量上报、plugin、skill、dependency 或 tool 路径失败
- **THEN** Main 必须记录已脱敏 recent-event 摘要
- **AND** 只有显式满足 blocking 准入时创建 P0 快照。

### Requirement: ELK TCP 接口

LYClaw MUST 通过 Electron Main 进程中的可替换 `LogForwardClient` 将已落盘快照发送到 TCP `10.0.1.62:5213`。

#### Scenario: 发送快照批次

- **WHEN** `LogForwarder` 读取到一批未确认的磁盘快照
- **THEN** TCP client 必须为该批次建立一个短连接
- **AND** 将每条完整快照编码为 UTF-8 `JSON.stringify(snapshot) + "\n"`
- **AND** 最后一条快照也必须以换行符结束
- **AND** Renderer 不得建立该 TCP 连接。

#### Scenario: 无应用层 ACK 的发送成功

- **WHEN** 服务端不返回应用层 ACK
- **AND** TCP client 在 5 秒内成功连接、写入完整批次并正常关闭连接
- **THEN** `LogForwarder` 必须将该批次标记为已发送
- **AND** 将快照发送进度写入本地 ack 文件
- **AND** 不得声称该结果证明 ELK 已完成解析或索引。

#### Scenario: TCP 发送失败

- **WHEN** 连接被拒绝、连接或写入 timeout、写入失败或连接异常关闭
- **THEN** client 必须返回 `network` 失败
- **AND** `LogForwarder` 不得更新该批次 ack
- **AND** 必须保留磁盘 spool 并应用既有网络退避
- **AND** 失败不得传播到 Chat、Gateway、Host API、Provider 或安全主流程。

#### Scenario: 并发 flush

- **WHEN** 多个 spool 或启动补发事件同时调度远端 flush
- **THEN** `LogForwarder` 必须合并或串行化发送
- **AND** 不得并发发送同一批未确认快照。

#### Scenario: 启动补发和落盘后调度

- **WHEN** 默认 Main 日志管线首次创建或 blocking P0 成功落盘
- **THEN** LYClaw 必须异步调度远端 flush
- **AND** 调用方不得等待 ELK 网络请求。

#### Scenario: 历史非阻断 spool

- **WHEN** 启动补发读取到 P1 或缺少 `userImpact = "blocking"` 的历史快照
- **THEN** `LogForwarder` MUST NOT 将该快照发送到 ELK
- **AND** MUST 在本地 ack 中将其标记为已处理，避免后续启动重复扫描。

#### Scenario: 迁移旧版 ID ack

- **WHEN** 启动补发读取到包含 `sentSnapshotIds` 的旧版 ack 文件
- **THEN** `LogForwarder` 必须只将文件中连续且已确认的前缀迁移为 `ackedOffset`、`ackedLine` 和 `lastSnapshotId`
- **AND** 不得重发该连续前缀中的 P0
- **AND** 不得跨过第一个未确认记录推进 offset。

#### Scenario: TCP client 自动化验证

- **WHEN** 运行日志转发单元测试
- **THEN** 测试必须使用本地临时 TCP server 验证 NDJSON framing 和成功关闭
- **AND** 本地快照 capture、spool、queue、脱敏或分级测试不得依赖真实 ELK 服务。
