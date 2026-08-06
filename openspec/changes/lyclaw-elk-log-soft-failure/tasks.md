# 任务清单

## 1. 规格和 Harness 准备

- [x] 1.1 在 `harness/specs/tasks/` 下新增 `lyclaw-elk-log-soft-failure.md` 任务 spec，引用 `gateway-backend-communication`。
- [x] 1.2 使用 `pnpm harness validate --spec harness/specs/tasks/lyclaw-elk-log-soft-failure.md --no-diff` 校验任务 spec 结构。

## 2. 软失败 Notice 识别（方案 2）

- [x] 2.1 在 `electron/utils/log-observability.ts` 新增 `isRuntimeSoftFailureNotice(content)` 识别函数，覆盖 `Agent failed before reply:`、`All models failed (` 与 `generate a response` 关键字。
- [x] 2.2 扩展 `observeGatewayNotificationForLog`，在 `method = agent` 且 `stream = final` 时提取 `data.message.content`，命中则 `captureSnapshot` 生成 `chat.run_error`/`CHAT_RUN_ERROR`、`failureStage = agent_message_failure` 的 P0 快照。
- [x] 2.3 复用 `isTrackedUserRun` 守卫，非用户 run 不采集。

## 2.x 工具类调用失败 P1 归类

- [x] 2x.1 在 spec/design/proposal 与 harness task spec 中明确工具类调用失败（Write/Nodes/Apply Patch/Message/Cron/Exec/Canvas/Dir List failed 等）归为 P1，不生成 `error_snapshot`、不写 spool、不转发 ELK。
- [x] 2x.2 在 `tests/unit/log-observability.test.ts` 新增 P1 测试，验证工具失败 content 不被 `isRuntimeSoftFailureNotice` 命中、不被 `observeGatewayNotificationForLog` 采集。

## 3. Renderer 后端卡死上报（方案 1）

- [x] 3.1 在 `electron/api/routes/log.ts` 新增 `POST /api/log/run-failure` route，校验 `sessionKey` 后调用 `captureLogErrorSnapshot`，生成 `chat.run_error`/`CHAT_RUN_ERROR`、`failureStage = backend_run_stuck` 的 P0 快照。
- [x] 3.2 在 `src/lib/host-api.ts` 新增 `reportRunFailureSnapshot(payload)`，走 `hostApiFetch` POST，不直连 ELK 或直接 IPC。
- [x] 3.3 在 `src/stores/chat.ts` 的 `backendRunStopped` 触发点 fire-and-forget 调用上报，`runId` 取 `activeRunIds[0]`，失败只 `console.warn`。

## 4. 测试（TDD）

- [x] 4.1 先在 `tests/unit/log-observability.test.ts` 添加失败测试：final stream 软失败 notice 生成 `chat.run_error` 快照、与 lifecycle/error 共享 fingerprint 去重、非软失败 content 不采集、非用户 run 不采集。
- [x] 4.2 在 `tests/unit/log-routes.test.ts`（或新增）添加 Host API route 测试：`backendRunStopped` 上报生成快照、缺 sessionKey 不采集、Renderer 不直连。
- [ ] 4.3 在 `tests/unit/chat-run-failure-report.test.ts` 新增 Renderer 上报集成测试。

## 5. 验证和文档

- [x] 5.1 运行 `pnpm harness validate --spec harness/specs/tasks/lyclaw-elk-log-soft-failure.md` 与 `pnpm harness run --spec harness/specs/tasks/lyclaw-elk-log-soft-failure.md --dry-run`。
- [x] 5.2 运行 `pnpm exec vitest run tests/unit/log-observability.test.ts tests/unit/log-routes.test.ts tests/unit/chat-run-failure-report.test.ts`。
- [x] 5.3 运行 `pnpm run comms:replay` 与 `pnpm run comms:compare`。
- [x] 5.4 运行 `pnpm run typecheck` 与 `pnpm run lint`。
- [x] 5.5 运行 `pnpm run build:vite`。
- [x] 5.6 按 `README.md`、`README.zh-CN.md`、`README.ja-JP.md` 文档同步规则更新 ELK 日志采集范围说明。
