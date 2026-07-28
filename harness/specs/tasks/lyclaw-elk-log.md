---
id: lyclaw-elk-log
title: 接入 LYClaw ELK 错误快照与 TCP 转发
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 按 OpenSpec change lyclaw-elk-log 实现 Main 进程错误快照闭环、核心链路埋点，并将已落盘快照通过 TCP NDJSON 转发到 10.0.1.62:5213，确保网络失败不影响 Chat/Gateway/Host API/Provider 主流程。
touchedAreas:
  - openspec/changes/lyclaw-elk-log/**
  - electron/utils/log-identity-context.ts
  - electron/utils/log-context-buffer.ts
  - electron/utils/error-snapshot.ts
  - electron/utils/log-forwarder.ts
  - electron/utils/log-observability.ts
  - electron/api/server.ts
  - electron/main/ipc/host-api-proxy.ts
  - electron/main/ipc-handlers.ts
  - electron/main/index.ts
  - electron/gateway/manager.ts
  - electron/security/audit-log.ts
  - tests/unit/log-identity-context.test.ts
  - tests/unit/log-context-buffer.test.ts
  - tests/unit/error-snapshot.test.ts
  - tests/unit/log-forwarder.test.ts
  - tests/unit/log-observability.test.ts
expectedUserBehavior:
  - Chat、Gateway、Host API、Provider 和安全主流程行为保持不变。
  - P0/P1 故障会在本地生成完整、已脱敏的 error_snapshot JSONL 快照。
  - debug/info、成功轮询和普通状态刷新不会生成错误快照。
  - ELK TCP 服务不可达或写入失败时，快照保留在本地 spool，主流程不等待远端发送。
  - Renderer 不新增直连 ELK、直连 Gateway HTTP 或直接 IPC 的日志投递路径。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/lyclaw-elk-log.md
  - pnpm exec vitest run tests/unit/log-identity-context.test.ts tests/unit/log-context-buffer.test.ts tests/unit/error-snapshot.test.ts tests/unit/log-forwarder.test.ts tests/unit/log-observability.test.ts
  - pnpm run typecheck
acceptance:
  - Main 进程提供 log-identity-context、log-context-buffer、error-snapshot、log-forwarder 四个边界清晰的模块。
  - captureErrorSnapshot(...) 只做轻量入队和调度，不等待磁盘写入或 ELK 网络请求。
  - snapshot JSONL 每行包含完整 error_snapshot 文档，字段覆盖 OpenSpec 中定义的快照数据内容。
  - recentEvents 只包含白名单摘要字段，最多 50 条，单条快照最大 64KB，超限设置 truncated=true。
  - 快照写入前会清洗 message、metadata、URL、baseUrl、路径摘要和常见密钥格式。
  - SnapshotSpoolWriter 串行 append JSONL，并将发送进度写入独立 ack 文件。
  - LogForwarder 只读取磁盘 spool，不直接消费内存队列；真实 client 使用一个 TCP 短连接向 10.0.1.62:5213 发送逐行 NDJSON。
  - 服务端无应用层 ACK；仅在完整批次写入并正常关闭后更新本地 ack，失败保留 spool 并按既有策略退避。
  - 默认 Main 管线启动时补发，P0/P1 落盘后异步调度发送，并发 flush 不重复发送同一未确认批次。
  - Host API、hostapi:fetch、gateway:rpc、gateway:httpProxy、Gateway lifecycle/chat 和 security audit 会记录核心 recent events。
  - 无新增 Renderer 直接 IPC、Gateway HTTP 或 ELK 网络调用。
docs:
  required: true
---

## Notes

真实 ELK 接口为无应用层 ACK 的 TCP `10.0.1.62:5213`。本变更不做 TLS、认证、Kibana dashboard、Renderer 可视化日志页面，也不上传人类可读 `LYClaw-YYYY-MM-DD.log` 原文。客户端成功写入只证明 TCP 投递完成，不证明 ELK 已解析或索引。
