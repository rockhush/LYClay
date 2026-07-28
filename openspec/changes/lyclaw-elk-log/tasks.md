# 任务清单

## 1. 规格和 Harness 准备

- [x] 1.1 在 `harness/specs/tasks/` 下新增本次 backend communication 变更的任务 spec。
- [x] 1.2 使用 `pnpm harness validate --spec <task-spec>` 校验任务 spec。
  - 已通过 `pnpm harness validate --spec harness/specs/tasks/lyclaw-elk-log.md --no-diff`。
  - 不带 `--no-diff` 的 changed-files 检查仍受当前工作区大量既有/无关差异影响，需在独立干净分支或基线收敛后再作为阻断项。

## 2. 快照核心能力

- [x] 2.1 定义 snapshot、recent event、queue、spool ack、reachability 等类型模型。
- [x] 2.2 新增 `electron/utils/log-identity-context.ts`，读取钉钉 `workNo`、`userName` 和身份缺失原因。
- [x] 2.3 实现统一脱敏能力，覆盖错误消息、metadata、路径、URL 和常见密钥格式。
- [x] 2.4 实现 `captureErrorSnapshot(...)`，确保它只做轻量入队，不等待磁盘写入，不等待 ELK 网络请求。

## 3. 上下文缓冲和分级

- [x] 3.1 新增 `electron/utils/log-context-buffer.ts`，维护 30 秒 Main 进程内存环形缓冲。
- [x] 3.2 实现 P0/P1 分级辅助逻辑，覆盖 app、chat、gateway、model、provider、host-api、security、channel、plugin、skill、usage、dependency、tool 等失败来源。
- [x] 3.3 按 `requestId`、`runId`、`sessionId`、`modelId/baseUrl` 关联 recent events，每条快照最多 50 条、最大 64KB。

## 4. 磁盘 Spool

- [x] 4.1 实现 `SnapshotSpoolWriter`，作为唯一异步 writer 写入 `logs/snapshots/LYClaw-YYYY-MM-DD.snapshot.jsonl`。
- [ ] 4.2 实现有界内存队列：1000 条或 8MB、P0 优先、P1 压缩/丢弃规则、本地 `log.pipeline` 诊断。
  - 已实现 1000 条/8MB 有界队列、P0 优先和 P1 优先丢弃；队列丢弃诊断仍待补充。
- [ ] 4.3 实现 P0 落盘规则：立即调度、P0 先于 P1、退出 drain、fatal shutdown emergency append。
  - 已实现 P0 立即调度和 P0 先于 P1；退出 drain 与 fatal shutdown emergency append 待补充。
- [ ] 4.4 实现 P1 落盘规则：空闲 5s、达到 50 条或 256KB、最旧等待 60s、P0 等待时延后。
  - 已实现 P1 空闲 5s 调度；批量阈值、最长等待和 P0 等待延后待补充。
- [x] 4.5 实现 spool 保留策略：最多 20MB 或最近 7 天，优先保留 P0。
- [x] 4.6 将发送确认写入独立 ack 文件 `LYClaw-YYYY-MM-DD.snapshot.ack.json`。

## 5. 转发

- [x] 5.1 新增 `electron/utils/log-forwarder.ts`，确保 `LogForwarder` 只读取磁盘 spool。
- [x] 5.2 实现 P0 落盘成功后立即 flush，且发送顺序 P0 先于 P1。
- [ ] 5.3 实现 P1 空闲、批量阈值、最长等待发送规则，并在批次间让出事件循环。
- [x] 5.4 实现 `LogServerReachability`：`unknown`、`reachable`、`unreachable`、`rejected`。
- [x] 5.5 实现网络失败退避：1min、5min、15min、30min。
- [x] 5.6 TCP 网络失败保留本地 spool，按 1min、5min、15min、30min 退避，并在退避到期后自动调度重试。
- [x] 5.7 将真实 TCP 请求客户端保持在可替换 `LogForwardClient` 边界内。
- [x] 5.8 实现 TCP `10.0.1.62:5213` 短连接 client，按批发送逐行 UTF-8 NDJSON，连接和写入超时为 5 秒。
  - 修改 `electron/utils/log-forwarder.ts`，导出 `createTcpLogForwardClient({ host, port, timeoutMs })`；默认值分别为 `10.0.1.62`、`5213`、`5000`。
  - 先在 `tests/unit/log-forwarder.test.ts` 使用本地临时 TCP server 写入失败测试，验证两条快照形成两行 JSON 且末尾带 `\n`，再实现最小 client 使测试通过。
- [x] 5.9 服务端无应用层 ACK；仅在完整批次成功写入并正常关闭后更新本地 ack，网络失败时保留 spool。
  - 先添加连接拒绝测试，断言 `reason = "network"`、ack 不存在且 spool 未删除，再实现 timeout/error/close 收敛逻辑。
- [x] 5.10 串行化或合并并发 flush，默认管线启动时补发，P0/P1 落盘后异步调度发送。
  - 先添加两个并发 `flushOnce()` 只调用一次 client 的失败测试，再在 `LogForwarder` 内串行化同一轮 flush。
  - 先在 `tests/unit/log-observability.test.ts` 添加 P0 落盘自动发送、P1 timer drain 自动发送和启动补发测试，再修改 `electron/utils/log-observability.ts` 导出 Main 初始化入口。
  - 修改 `electron/main/index.ts`，在 Main ready 生命周期异步初始化补发；不得由 Renderer 触发。

## 6. 埋点接入

- [ ] 6.1 在 Host API route、`hostapi:fetch`、Gateway RPC、Gateway HTTP proxy 路径记录 Main 进程 recent events。
  - 已接入 Host API route、`hostapi:fetch`、Gateway RPC；Gateway HTTP proxy 路径待补充。
- [ ] 6.2 记录 Gateway lifecycle、transport、heartbeat、chat run、stale/empty-final recovery、restart/reload fallback 事件。
  - 已覆盖 Gateway RPC transport 成功/失败，以及 `agent/lifecycle/error` 运行失败通知；完整 heartbeat、chat run recovery、restart/reload fallback 待补充。
- [x] 6.3 记录 security deny/high/critical/user refusal 等 P1 审计事件。
- [ ] 6.4 记录 Sub2API、DWS、钉钉集成、Provider、OAuth、模型同步、用量上报、插件、技能、系统依赖、工具失败事件。
- [x] 6.5 Renderer crash/error-boundary 只能通过 Main 生成快照，不新增 Renderer 直连 ELK。

## 7. 验证

- [x] 7.1 添加 schema 生成、身份 fallback、脱敏、URL/path 清洗、截断、分级单元测试。
- [x] 7.2 添加队列压力、P0/P1 顺序、spool append、ack、retention、reachability、retry 单元测试。
- [x] 7.3 如果实现改变用户可见 UI，补充代表性 Electron E2E 用例。
  - 未改 UI，无需新增 E2E。
- [ ] 7.4 运行 `pnpm run typecheck`。
  - 2026-07-28 再次运行但仍失败，失败集中在当前分支既有前端、Electron 和共享类型问题；本次修改文件定向 ESLint 与新增 Vitest 已通过。
- [x] 7.5 运行新增日志管线相关 Vitest 用例。
- [x] 7.6 因触碰通信路径，运行 `pnpm run comms:replay` 和 `pnpm run comms:compare`。
- [x] 7.7 检查 `README.md`、`README.zh-CN.md`、`README.ja-JP.md`，行为、流程或接口变化时同步更新。
- [x] 7.8 使用本地临时 TCP server 验证 NDJSON framing、无 ACK 成功、失败保留 spool 和并发 flush 去重。
- [x] 7.9 向 `10.0.1.62:5213` 发送三条带唯一测试标识的模拟 `error_snapshot`，记录 TCP 连接和写入结果，不将其表述为服务端已索引确认。
  - 最终 TCP client 探针返回 `{ ok: true }`，耗时约 42ms；快照 ID 为 `lyclaw_tcp_probe_20260728_140600_1`、`lyclaw_tcp_probe_20260728_140600_2`、`lyclaw_tcp_probe_20260728_140600_3`。
