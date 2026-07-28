# 设计：LYClaw ELK 错误快照日志

## 概览

本日志管线只采集 P0/P1 排障快照，不做普通日志上传。一次快照必须帮助研发确认：谁遇到问题、哪个请求/运行/会话/模型/baseUrl 相关、发生了什么归一化错误、错误附近有哪些已脱敏事件。

Electron Main 进程负责完整链路：capture、脱敏、上下文缓冲、入队、磁盘 spool、ack、网络可达性和转发。Renderer 只能通过已有 Main-owned route 报告 crash 或 ErrorBoundary 错误。

## 快照文档

ELK 只接收 `documentType = "error_snapshot"` 的文档。

本地 `logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.jsonl` 同样必须保存完整快照内容：一行一条完整、已脱敏、可独立排障的 `error_snapshot` JSON 文档。ack 文件只保存发送进度，不得替代 snapshot JSONL 内容；`LogForwarder` 必须从 snapshot JSONL 读取完整文档发送。

必需字段：

- `documentType`：固定 `error_snapshot`
- `schemaVersion`
- `snapshotId`
- `ts`
- `priority`：`p0` 或 `p1`
- `level`：`error` 或 `warn`
- `errorCode`
- `message`
- `source`
- `eventName`
- `component`
- `workNo`
- `userName`
- `identityMissingReason`
- `requestId`
- `runId`
- `sessionId`
- `modelId`
- `baseUrl`
- `method`
- `route`
- `status`
- `statusCode`
- `durationMs`
- `retryCount`
- `fallbackUsed`
- `recovered`
- `recentEvents`
- `metadata`
- `truncated`

聊天、Gateway RPC、Provider、模型调用链路快照必须包含当前失败路径可获得的 `sessionId`、`modelId` 和 `baseUrl`。身份字段始终以字符串存在；无法获取时使用空字符串，并在脱敏 metadata 或本地 pipeline 诊断中记录身份缺失原因。

`recentEvents` 的每条事件只能包含 `ts`、`eventName`、`component`、`method`、`route`、`status`、`statusCode`、`durationMs`、`errorCode`、`result`、`requestId`、`runId`、`sessionId`、`modelId`、`baseUrl`、`metadata`。`metadata` 只能是小型、已脱敏、白名单结构化字段。

快照文件不得保存 Prompt 正文、模型响应正文、Transcript 正文、文件内容、人类可读日志整段原文、Provider Key、Bearer Token、OAuth Code、DWS Token、带凭据 URL 或完整敏感路径。

## 脱敏

快照和 recent events 不允许包含 Prompt 正文、模型响应正文、Transcript 正文、文件内容、Provider Key、Bearer Token、OAuth Code、DWS Token、带凭据 query string 或 URL 中的原始凭据。`baseUrl` 只能包含协议、host 和基础路径。任何 message、path、URL、metadata 进入内存队列、磁盘 spool 或远端发送前都必须经过脱敏。

## Recent Events

`recentEventsBuffer` 保存最近 30 秒的已脱敏事件摘要。每条事件可包含时间、事件名、组件、route/path/method、状态、耗时、错误码、结果、`requestId`、`runId`、`sessionId`、`modelId`、`baseUrl`。

快照组装时最多保留 50 条事件，序列化总大小最多 64KB。优先保留相同 `requestId`、`runId`、`sessionId`、`modelId/baseUrl` 的事件。P0 可额外等待最多 5 秒收集错误后的恢复或失败事件。超过大小上限时先截断 recent events，并设置 `truncated = true`。

## P0 和 P1

P0 只用于当前不可用故障：程序不可用、当前聊天会话不可用、当前选中模型不可用、Gateway 传输阻断当前会话、工具运行阻断当前会话、当前模型下游不可用。

P1 用于可恢复、局部、后台、非当前链路或安全审计问题：Chat/Gateway 恢复类异常、单个 Host API route 错误、security deny/high/critical 审计、channel/agent/plugin/skill/provider/OAuth/Sub2API/DWS/钉钉/用量/依赖/tool 等不阻断当前程序、会话或选中模型的问题。

debug/info、成功轮询、普通刷新和 P2 类型运行噪声不生成快照。

## 队列和 Spool

`snapshotWriteQueue` 上限为 1000 条或 8MB。P0 走高优先级队列；P1 走普通队列，入队前可以按 fingerprint 限频、采样或合并。只要 P1 已经入队，就必须按确定规则落盘。

`SnapshotSpoolWriter` 是唯一 writer。业务流程不得同步写 snapshot 文件。快照文件按天追加写入：

```text
logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.jsonl
```

ack 文件独立保存：

```text
logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.ack.json
```

磁盘 spool 最多保留 20MB 或最近 7 天，超限时优先保留 P0，再压缩或丢弃 P1。

## 落盘规则

P0 入队后 0-50ms 内调度 writer，P0 先于 P1 drain，允许单条 append。应用退出时最多等待 1500ms drain P0 和已开始批次。Main fatal 或即将崩溃时，仅允许对当前 P0 使用 emergency sync append。

P1 在以下情况 drain：主流程空闲且距最近 P1 入队超过 5000ms；P1 队列达到 50 条或 256KB；最旧 P1 等待超过 60 秒。只要有 P0 等待，P1 延后。

空闲判断指：没有当前用户 `chat.send` RPC in-flight；没有当前 Chat run 处于 streaming、pending final、工具执行、abort 或 recovery；Gateway 不处于 starting、reconnecting、restart/reload 关键阶段；没有用户触发的 Host API mutation 正在执行；最近 1s Main event loop lag 不超过 100ms。

## 转发规则

`LogForwarder` 只读取磁盘 spool，不直接消费内存队列。

P0 落盘成功后立即调度 flush，且发送顺序先 P0 后 P1。P1 在主流程空闲且网络可达时批量发送；未发送 P1 达到 50 条或 256KB 时批量发送；最旧未发送 P1 超过 60 秒时发送小批次。若 Chat/Gateway 用户关键流程活跃，P1 最多延后 120 秒，之后只发送 10 条或 64KB 小批次。

本阶段 TCP client 使用 `unknown`、`reachable`、`unreachable` 可达性状态。网络失败按 1min、5min、15min、30min 退避，并在退避到期后自动调度重试；失败期间只保留本地 spool 并限频记录 pipeline 诊断。`rejected` 仅作为未来认证协议扩展的保留类型，不是本阶段 TCP client 可产生的状态。

真实日志入口为 TCP `10.0.1.62:5213`。Main 进程在每次 flush 时建立一个短连接，将批次中的每条完整快照编码为 UTF-8 NDJSON：`JSON.stringify(snapshot) + "\n"`。一个批次复用一个连接，最后一条记录也必须以换行符结束。

服务端不返回应用层 ACK。客户端必须在 5 秒内完成连接和写入，并在完整批次写入后调用 `socket.end()`；连接、写入和正常关闭均未报错时，`LogForwarder` 才将该批次记录到本地 ack。该成功只代表客户端 TCP 写入成功，不代表 ELK 已完成解析或索引。

连接拒绝、timeout、写入失败或异常关闭统一视为 `network` 失败，不更新 ack，完整快照继续保留在磁盘 spool，并沿用 1min、5min、15min、30min 退避。TCP client 不保持长连接，不实现应用层心跳、TLS 或认证。并发 flush 必须合并或串行化，避免同一未确认批次被并发重复发送。

P0 成功 append 到 spool 后立即异步调度远端 flush；P1 完成 spool drain 后异步调度 flush。默认管线首次创建时异步尝试补发历史 spool。所有网络任务都不得被 capture、Chat、Gateway、Host API、Provider 或安全主流程等待。

## 验证策略

验证必须证明：P0/P1 触发快照；P2/debug/info/成功轮询不触发；`captureErrorSnapshot(...)` 不阻塞；P1 按确定阈值落盘和发送；模型链路快照包含身份、session、model、baseUrl；快照不包含敏感内容或正文；本地 TCP server 收到逐行 NDJSON；连接或写入失败不更新 ack；并发 flush 不重复发送；ELK 失败不影响 Chat、Gateway、Host API、Provider 主流程。最后向 `10.0.1.62:5213` 发送三条带唯一测试标识的模拟快照，只将客户端连接和写入成功作为本地验证结果。
