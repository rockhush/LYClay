# 设计：LYClaw ELK 错误快照日志

## 概览

本日志管线只采集阻碍用户当前使用的 P0 排障快照，不做普通日志或安全审计上传。一次快照必须帮助研发确认：谁遇到问题、哪个请求/运行/会话/模型/baseUrl 相关、哪个用户操作被阻断、失败发生在哪个阶段、错误附近有哪些已脱敏事件。

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
- `userImpact`：ELK-bound 快照固定为 `blocking`
- `operationKind`：被阻断的用户操作类型
- `failureStage`：失败阶段
- `fingerprint`：用于合并同类严重错误的稳定标识
- `occurrenceCount`：当前进程内该 fingerprint 的累计次数
- `firstSeenAt`
- `lastSeenAt`
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

会话关联字段按可用性输出：

- `sessionKey`：原始 OpenClaw runtime session key，例如 `agent:main:session-1785285317125`。失败入口能获得 runtime session key 时必须保留该字段。
- `sessionId`：对应 transcript 文件名中的标准 UUID，例如 `977e72a4-3784-488c-9919-2284dad5a1c3`。该字段不得保存 runtime session key。

聊天、Gateway RPC、Provider、模型调用链路快照必须包含当前失败路径可获得的 `sessionKey`、`modelId` 和 `baseUrl`，并尽力解析 transcript UUID。身份字段始终以字符串存在；无法获取时使用空字符串，并在脱敏 metadata 或本地 pipeline 诊断中记录身份缺失原因。

Main 在快照组装阶段解析会话上下文。它从 `sessionKey` 的 `agent:<agentId>:` 前缀提取 agentId，读取当前 OpenClaw 配置目录下 `agents/<agentId>/sessions/sessions.json` 的同 key 条目，按以下顺序选择 UUID：

1. 从 `sessionFile` basename 解析普通、`.deleted.jsonl` 或 `.jsonl.reset.*` transcript 文件名中的 UUID；
2. 若未得到 UUID，读取条目的 `sessionId`；
3. 若仍未得到 UUID，读取条目的 `id`。

候选值必须是合法、标准的 UUID；解析成功后写入顶层 `sessionId`。session key 不合法、索引不存在、文件不可读、条目缺失或候选值不是 UUID 时，快照仍可生成和发送，但只能保留顶层 `sessionKey` 并省略 `sessionId`，不得用 session key 兜底填充 `sessionId`。映射失败不得阻塞用户流程或 ELK 管线。

`recentEvents` 的每条事件只能包含 `ts`、`eventName`、`component`、`method`、`route`、`status`、`statusCode`、`durationMs`、`errorCode`、`result`、`requestId`、`runId`、`sessionId`、`modelId`、`baseUrl`、`metadata`。`metadata` 只能是小型、已脱敏、白名单结构化字段。

快照文件不得保存 Prompt 正文、模型响应正文、Transcript 正文、文件内容、人类可读日志整段原文、Provider Key、Bearer Token、OAuth Code、DWS Token、带凭据 URL 或完整敏感路径。

## 脱敏

快照和 recent events 不允许包含 Prompt 正文、模型响应正文、Transcript 正文、文件内容、Provider Key、Bearer Token、OAuth Code、DWS Token、带凭据 query string 或 URL 中的原始凭据。`baseUrl` 只能包含协议、host 和基础路径。任何 message、path、URL、metadata 进入内存队列、磁盘 spool 或远端发送前都必须经过脱敏。

## Recent Events

`recentEventsBuffer` 保存最近 30 秒的已脱敏事件摘要。每条事件可包含时间、事件名、组件、route/path/method、状态、耗时、错误码、结果、`requestId`、`runId`、`sessionId`、`modelId`、`baseUrl`。为保持现有事件关联能力，recent event 的 `sessionId` 继续保存 runtime session key；transcript UUID 只用于快照顶层 `sessionId`。

快照组装时最多保留 50 条事件，序列化总大小最多 64KB。优先保留相同 `requestId`、`runId`、runtime session key、`modelId/baseUrl` 的事件；收集事件时使用快照输入的 `sessionKey`，不得改用解析后的 transcript UUID。P0 可额外等待最多 5 秒收集错误后的恢复或失败事件。超过大小上限时先截断 recent events，并设置 `truncated = true`。

## ELK 准入和优先级

ELK-bound 快照必须同时满足 `priority = "p0"` 和 `userImpact = "blocking"`。采集入口必须显式声明用户影响；缺失该字段时默认拒绝生成、落盘和发送，避免新增入口意外扩大日志量。

P0 只用于当前程序或当前用户操作不可用，且自动恢复、fallback 或重试未恢复的故障。本阶段允许进入 ELK 的入口为：Gateway 明确返回失败的当前用户 `chat.send`、Main 通过 `runId` 精确跟踪的当前用户 Chat run 最终失败，以及 Host API 服务端最终返回 5xx 或抛出异常导致当前请求失败。`chat.send` ack timeout 只表示 RPC 结果未知，timeout 当下只记录 recent event，不生成快照；后续若收到已跟踪 run 的 lifecycle error，再由最终失败入口生成快照。

`sessions.abort`、`skills.status`、warmup、cron、后台 agent、后台恢复、普通轮询、重复的 Host API proxy 5xx、security deny/high/critical 和其他本地安全审计均不生成快照。非阻断事件仍可进入本地 regular log、recent-events buffer 或独立安全审计日志，但不得进入 snapshot spool 或 ELK。

## 严重错误合并

Main 进程按 `eventName + errorCode + method + route + session identity` 生成稳定 `fingerprint`。session identity 优先使用解析后的 transcript UUID；无法解析时使用原始 `sessionKey`，两者都不存在时使用空值。同一 fingerprint 首次出现时立即生成快照；随后 5 分钟内只累计次数，不生成、落盘或发送重复快照。窗口结束后的下一次发生重新生成快照，并携带该进程内累计 `occurrenceCount`、`firstSeenAt` 和 `lastSeenAt`。聚合状态必须有界，最多保留 1000 个 fingerprint。

## 队列和 Spool

`snapshotWriteQueue` 上限为 1000 条或 8MB。通过 ELK 准入的 P0 走高优先级队列。未通过准入的事件不得进入队列。

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

P0 入队后 0-50ms 内调度 writer，允许单条 append。应用退出时最多等待 1500ms drain P0 和已开始批次。Main fatal 或即将崩溃时，仅允许对当前 P0 使用 emergency sync append。

历史版本留下的 P1、缺少 `userImpact = "blocking"` 或不满足完整 schema 的 spool 记录不得发送到 ELK；`LogForwarder` 必须按文件字节 offset 和行号将这些记录在本地标记为已处理，避免每次启动重复扫描。旧版 `sentSnapshotIds` ack 必须按连续已确认前缀一次性迁移，不得重发已确认 P0。

## 转发规则

`LogForwarder` 只读取磁盘 spool，不直接消费内存队列。

P0 落盘成功后立即调度 flush。历史 P1 或缺少 blocking 标记的记录只更新本地 ack，不进入发送批次。

本阶段 TCP client 使用 `unknown`、`reachable`、`unreachable` 可达性状态。网络失败按 1min、5min、15min、30min 退避，并在退避到期后自动调度重试；失败期间只保留本地 spool 并限频记录 pipeline 诊断。`rejected` 仅作为未来认证协议扩展的保留类型，不是本阶段 TCP client 可产生的状态。

真实日志入口为 TCP `10.0.1.62:5213`。Main 进程在每次 flush 时建立一个短连接，将批次中的每条完整快照编码为 UTF-8 NDJSON：`JSON.stringify(snapshot) + "\n"`。一个批次复用一个连接，最后一条记录也必须以换行符结束。

服务端不返回应用层 ACK。客户端必须在 5 秒内完成连接和写入，并在完整批次写入后调用 `socket.end()`；连接、写入和正常关闭均未报错时，`LogForwarder` 才将该批次记录到本地 ack。该成功只代表客户端 TCP 写入成功，不代表 ELK 已完成解析或索引。

连接拒绝、timeout、写入失败或异常关闭统一视为 `network` 失败，不更新 ack，完整快照继续保留在磁盘 spool，并沿用 1min、5min、15min、30min 退避。TCP client 不保持长连接，不实现应用层心跳、TLS 或认证。并发 flush 必须合并或串行化，避免同一未确认批次被并发重复发送。

P0 成功 append 到 spool 后立即异步调度远端 flush。默认管线首次创建时异步尝试补发历史 spool，但只发送满足当前 ELK 准入规则的记录。所有网络任务都不得被 capture、Chat、Gateway、Host API、Provider 或安全主流程等待。

## 验证策略

验证必须证明：只有显式 blocking 的 P0 触发快照；security、`sessions.abort`、`skills.status`、后台 agent、debug/info、成功轮询和普通状态刷新不触发；同 fingerprint 5 分钟内只生成一次；历史非 blocking spool 不发送；当前用户 Chat 严重失败、Host API 最终 5xx/exception 正常生成；`captureErrorSnapshot(...)` 不阻塞；模型链路快照包含身份、session、model、baseUrl；`sessionFile`、`sessionId` 和 `id` 映射按既定优先级得到 transcript UUID；非法或缺失映射时只保留 `sessionKey`；recent events 仍按 runtime session key 关联；fingerprint 优先使用 UUID、失败时回退 session key；快照不包含敏感内容或正文；本地 TCP server 收到逐行 NDJSON；连接或写入失败不更新 ack；并发 flush 不重复发送；ELK 失败不影响 Chat、Gateway、Host API、Provider 主流程。
