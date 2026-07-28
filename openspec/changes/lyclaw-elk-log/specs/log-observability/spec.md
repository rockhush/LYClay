
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

#### Scenario: 创建快照

- **WHEN** 捕获 P0 或 P1 失败
- **THEN** 快照必须包含 `snapshotId`、`ts`、`priority`、`level`、`source`、`eventName`、`component`、`errorCode`、`message`、`workNo`、`userName`、`identityMissingReason`、`requestId`、`runId`、`sessionId`、`modelId`、`baseUrl`、`method`、`route`、`status`、`statusCode`、`durationMs`、`retryCount`、`fallbackUsed`、`recovered`、`recentEvents`、`metadata`、`truncated`
- **AND** `priority` 必须是 `p0` 或 `p1`
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
- **THEN** 快照必须包含当前链路可获得的 `sessionId`、`modelId` 和 `baseUrl`
- **AND** `baseUrl` 只能包含协议、host 和基础路径。

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
- **AND** 必须优先保留相同 `requestId`、`runId`、`sessionId` 或 `modelId/baseUrl` 的事件
- **AND** `recentEvents` 最多包含 50 条。

#### Scenario: P0 等待错误后上下文

- **WHEN** 捕获 P0 快照
- **THEN** LYClaw 可以等待最多 5 秒收集恢复或追加失败事件
- **AND** 该等待不得阻塞用户可见的失败流程。

#### Scenario: 快照超过大小限制

- **WHEN** 序列化后的快照会超过 64KB
- **THEN** LYClaw 必须截断 `recentEvents`
- **AND** 设置 `truncated = true`。

### Requirement: 优先级分级

LYClaw MUST 为 P0/P1 失败创建快照，并且不得为 debug/info、成功轮询、普通状态刷新或 P2 运行噪声创建快照。

#### Scenario: 当前流程不可用

- **WHEN** 当前程序、当前聊天会话、当前选中模型、Gateway 传输、阻断型工具运行或当前模型下游路径不可用，且自动恢复、fallback 或重试无法恢复
- **THEN** LYClaw 必须将该失败归类为 P0
- **AND** 创建 `error_snapshot`。

#### Scenario: 失败可恢复或局部化

- **WHEN** Chat、Gateway、Host API、security、channel、agent、plugin、skill、Provider、OAuth、Sub2API、DWS、钉钉、用量上报、系统依赖或工具失败是可恢复、局部、后台、非当前链路或审计型问题
- **THEN** LYClaw 必须将该失败归类为 P1
- **AND** 创建 `error_snapshot`。

#### Scenario: Chat timeout 后恢复

- **WHEN** `chat.send` ack timeout 后，Gateway 事件或 transcript fallback 最终产生可见进展或 final
- **THEN** LYClaw 不得将该事件归类为 P0
- **AND** 可以将该事件归类为 P1。

### Requirement: 有界写队列

LYClaw MUST 在磁盘 spool 写入前使用有界且有优先级的 `snapshotWriteQueue`。

#### Scenario: 快照进入队列

- **WHEN** P0 快照入队
- **THEN** 它必须进入高优先级队列。

#### Scenario: P1 快照进入队列

- **WHEN** P1 快照准备入队
- **THEN** LYClaw 可以在入队前按 fingerprint 限频、采样或合并
- **AND** 一旦入队，必须遵守确定的磁盘写入规则。

#### Scenario: 队列达到压力上限

- **WHEN** 队列将超过 1000 条快照或 8MB
- **THEN** LYClaw 必须先压缩 P1 的 `recentEvents`
- **AND** 若仍超限，则丢弃最旧 P1
- **AND** 只有 P1 释放仍不足时，才压缩 P0 的 `recentEvents`
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
- **THEN** LYClaw 必须优先保留 P0 快照，再压缩或丢弃 P1 快照。

### Requirement: P0 落盘行为

LYClaw MUST 优先持久化 P0 快照。

#### Scenario: P0 入队

- **WHEN** P0 快照进入写队列
- **THEN** writer 必须在 0-50ms 内被调度
- **AND** 等待中的 P0 必须先于 P1 drain。

#### Scenario: 应用退出

- **WHEN** LYClaw 正在退出
- **THEN** Main 必须最多等待 1500ms，用于 drain P0 和已开始批次。

#### Scenario: Fatal shutdown

- **WHEN** Main 即将崩溃或无法依赖异步 writer
- **THEN** LYClaw 可以只对当前 P0 快照执行 emergency sync append。

### Requirement: P1 落盘行为

LYClaw MUST 按确定的空闲、批量和最长等待规则持久化 P1 快照。

#### Scenario: 用户主流程空闲

- **WHEN** 没有当前用户 `chat.send` RPC in-flight、没有当前 Chat run 处于 streaming/pending final/tool/abort/recovery、Gateway 不在关键 start/reconnect/restart/reload 阶段、没有用户触发的 Host API mutation、且最近 Main event-loop lag 不超过 100ms
- **AND** 距最近 P1 入队至少已经过去 5000ms
- **THEN** LYClaw 必须 drain 一批 P1。

#### Scenario: P1 达到批量阈值

- **WHEN** P1 队列达到 50 条快照或 256KB
- **THEN** LYClaw 必须 drain 一小批 P1，除非有 P0 正在等待。

#### Scenario: 最旧 P1 等待过久

- **WHEN** 最旧 P1 在内存中等待超过 60 秒
- **THEN** LYClaw 必须强制 drain 一小批 P1，除非有 P0 正在等待。

### Requirement: 基于磁盘的转发

`LogForwarder` MUST 从已持久化的 snapshot spool 文件读取，且不得直接消费内存队列。

#### Scenario: P0 已落盘

- **WHEN** P0 快照成功 append 到 spool
- **THEN** LYClaw 必须立即调度远端 flush
- **AND** P0 必须先于 P1 发送。

#### Scenario: P1 可以发送

- **WHEN** 用户主流程空闲、网络可达、磁盘存在未发送 P1
- **THEN** LYClaw 必须批量发送 P1 快照。

#### Scenario: P1 达到发送阈值

- **WHEN** 未发送 P1 达到 50 条、256KB，或最旧未发送 P1 超过 60 秒
- **THEN** LYClaw 必须发送一个批次
- **AND** 在批次之间让出事件循环。

#### Scenario: 用户关键流程活跃

- **WHEN** Chat 或 Gateway 用户关键流程活跃
- **THEN** P1 发送可以延后最多 120 秒
- **AND** 超过后 LYClaw 最多只发送 10 条快照或 64KB 小批次。

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

LYClaw MUST 在可能产生 P0/P1 快照的路径上记录已脱敏 recent events。

#### Scenario: 后端通信路径运行

- **WHEN** Host API route、`hostapi:fetch`、`gateway:rpc` 或 `gateway:httpProxy` 成功、失败或慢响应
- **THEN** Main 必须记录已脱敏 recent-event 摘要。

#### Scenario: Runtime 和集成路径失败

- **WHEN** Gateway lifecycle/transport/heartbeat/chat recovery、security audit、Sub2API、DWS、钉钉、Provider、OAuth、模型同步、用量上报、plugin、skill、dependency 或 tool 路径失败
- **THEN** Main 必须记录已脱敏 recent-event 摘要
- **AND** 在分级规则要求时创建 P0/P1 快照。

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

- **WHEN** 默认 Main 日志管线首次创建、P0 成功落盘或 P1 完成 drain
- **THEN** LYClaw 必须异步调度远端 flush
- **AND** 调用方不得等待 ELK 网络请求。

#### Scenario: TCP client 自动化验证

- **WHEN** 运行日志转发单元测试
- **THEN** 测试必须使用本地临时 TCP server 验证 NDJSON framing 和成功关闭
- **AND** 本地快照 capture、spool、queue、脱敏或分级测试不得依赖真实 ELK 服务。
