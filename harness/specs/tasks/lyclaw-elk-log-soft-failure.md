---
id: lyclaw-elk-log-soft-failure
title: 补齐 ELK 软失败 Notice 与后端卡死 P0 快照采集
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 按 OpenSpec change lyclaw-elk-log-soft-failure，补齐两类阻碍用户使用的 blocking P0 失败的快照采集：runtime 经 agent final stream 下发的软失败 notice content，以及 Renderer 判定的后端 Agent 卡死（backendRunStopped）。复用 lyclaw-elk-log 的脱敏、磁盘 spool 与 TCP 转发链路，不新增网络出口或 Renderer 直连路径。
touchedAreas:
  - openspec/changes/lyclaw-elk-log-soft-failure/**
  - electron/utils/log-observability.ts
  - electron/api/routes/log.ts
  - electron/api/server.ts
  - src/lib/host-api.ts
  - src/stores/chat.ts
  - tests/unit/log-observability.test.ts
  - tests/unit/log-routes.test.ts
  - tests/unit/chat-run-failure-report.test.ts
expectedUserBehavior:
  - Chat、Gateway、Host API、Provider 和安全主流程行为保持不变。
  - runtime 经 agent final stream 下发的软失败 notice（Agent failed before reply:、All models failed、couldn't generate a response）在已跟踪用户 run 上生成 chat.run_error P0 快照。
  - Renderer 判定的后端 Agent 卡死（backendRunStopped）通过 Main-owned Host API route 上报并生成 chat.run_error P0 快照。
  - sessions.abort、aborted 状态和用户主动停止仍不生成快照，准入原则不变。
  - 工具类调用失败（Write failed、Nodes failed、Apply Patch failed、Message failed、Cron failed、Exec failed、Canvas failed、Dir List failed 等 tool result isError 或 tool-run-registry failed/timeout/kill_failed）归为 P1，不生成 error_snapshot、不写入 snapshot spool、不转发 ELK，只在本地 recent-events buffer 或 regular log 记录。
  - 同一 run 同时产生 lifecycle/error 与 final 软失败 notice 时，5 分钟内只生成一条快照。
  - Renderer 不新增直连 ELK、直连 Gateway HTTP 或直接 IPC 的日志投递路径。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/lyclaw-elk-log-soft-failure.md
  - pnpm exec vitest run tests/unit/log-observability.test.ts tests/unit/log-routes.test.ts tests/unit/chat-run-failure-report.test.ts
  - pnpm run typecheck
acceptance:
  - observeGatewayNotificationForLog 在 agent final stream 命中软失败 notice 时生成 chat.run_error/CHAT_RUN_ERROR、failureStage=agent_message_failure 的 P0 快照。
  - 软失败 notice 识别覆盖 Agent failed before reply:、All models failed ( 与 generate a response 关键字。
  - 非 user run 的软失败 notice 不采集；非软失败 final content 不采集。
  - 软失败 notice 与 lifecycle/error 共享 eventName/errorCode，靠 fingerprint 5 分钟去重，不重复落盘。
  - POST /api/log/run-failure route 接收 Renderer 上报，生成 chat.run_error/CHAT_RUN_ERROR、failureStage=backend_run_stuck 的 P0 快照。
  - reportRunFailureSnapshot 经 host-api.ts 调用，不直连 ELK 或直接 IPC；上报失败不阻塞 Renderer。
  - backendRunStopped 触发时 Renderer fire-and-forget 上报，runId 取 activeRunIds[0]。
  - 缺 sessionKey 的上报不采集但仍返回 200。
  - 工具类调用失败（tool result isError=true 或 content 以 failed 结尾/含 failed:）生成 priority=p1、userImpact=non-blocking、operationKind=app_runtime、failureStage=tool_execution 的 error_snapshot，写入 snapshot spool 并转发 ELK，归类为 P1。
  - P1 落盘按空闲 5s 批量调度，不抢占 P0；转发批次中 P0 先于 P1 写入 TCP（sortSnapshots）。
  - isElkEligibleSnapshot 接受 p0 与 p1（userImpact 为 blocking 或 non-blocking）。
  - 非用户 run（后台 agent/warmup/cron）的 tool failure 不采集。
docs:
  required: false
---

## Notes

本变更不放宽 sessions.abort/aborted 准入，不新增网络出口，不改脱敏/spool/转发链路。真实 ELK 接口仍为 TCP `10.0.1.62:5213`。
