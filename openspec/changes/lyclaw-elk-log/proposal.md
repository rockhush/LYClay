





# 变更：LYClaw ELK 错误快照日志

## 为什么

LYClaw 当前排查线上问题时，通常依赖用户反馈和本地日志导出。若日志上下文不完整，研发还需要反复确认用户身份、会话、模型、网络路径和错误前后事件，定位慢且容易丢失现场。

本变更的目标不是简单上传日志，而是在阻碍用户当前使用的 P0 故障发生时，由 Electron Main 进程生成一份已脱敏、可关联、可落盘、可转发到 ELK 的 `error_snapshot`。研发可以在 Kibana 中直接看到一次可行动的严重错误快照，减少向用户索要本地日志的次数，同时避免后台、清理、审计和可恢复错误淹没 ELK。

## 改什么

- 新增结构化 `error_snapshot` 文档，包含身份、请求、会话、模型、baseUrl、归一化错误和有限的 recent events；顶层 `sessionId` 保存 transcript 文件名 UUID，顶层 `sessionKey` 保存原始 OpenClaw runtime session key。
- Main 在组装快照时根据 `sessionKey` 查询对应 agent 的 `sessions/sessions.json`：优先从 `sessionFile` 文件名解析 UUID，其次读取索引条目的 `sessionId` 或 `id`。无法解析合法 UUID 时保留 `sessionKey` 并省略 `sessionId`，不得将 runtime session key 回填到 `sessionId`。
- 快照生成、脱敏、上下文缓冲、内存队列、磁盘 spool、ack 和远端转发全部归 Electron Main 进程所有。
- Renderer 不直接访问 ELK、内网日志服务或 Gateway HTTP 日志通道。
- 写入内存、磁盘或远端前必须脱敏 Prompt 正文、模型响应正文、Transcript 正文、文件内容、Provider Key、Bearer Token、OAuth Code、DWS Token 和带凭据 URL。
- 只有采集入口显式声明 `userImpact = "blocking"` 的 P0 故障才生成并转发快照；未声明、后台、清理、审计、可恢复、普通刷新和安全策略事件均不进入 ELK 快照链路。
- 相同严重错误按稳定 fingerprint 在 5 分钟窗口内合并，下一次允许上传时携带累计次数和首次/末次发生时间。
- 快照先异步落盘到 JSONL spool，`LogForwarder` 只从磁盘读取发送，不直接消费内存队列。
- ELK TCP 连接被拒绝、DNS/内网不可达、连接或写入 timeout、写入失败或异常关闭时，不影响 Chat、Gateway、Host API、Provider 和安全主流程。
- 通过 Main 进程 TCP client 将已落盘快照以 NDJSON 发送到 `10.0.1.62:5213`；服务端不返回应用层 ACK，客户端成功写完并正常关闭连接后更新本地 ack。

## 影响范围

- 可能涉及：
  - `electron/api/server.ts`
  - `electron/main/ipc/host-api-proxy.ts`
  - `electron/main/ipc-handlers.ts`
  - `electron/gateway/manager.ts`
  - `electron/security/audit-log.ts`
  - `electron/services/sub2api/**`
  - `electron/services/providers/**`
  - `electron/utils/**`
  - `src/App.tsx`
  - `src/components/common/ErrorBoundary.tsx`
- 实现会触碰 backend communication 路径，实施前必须新增 harness task spec，并引用 `gateway-backend-communication`。
- 用户可见行为原则上不变化；当 `10.0.1.62:5213` 可达时，研发侧获得远端排障快照。
- 实现后需要按文档同步规则检查 `README.md`、`README.zh-CN.md`、`README.ja-JP.md`。

## 来源

需求来源：`/Users/lstech/mac-windows/设计文档/LYClaw-ELK日志接入设计.md`。
