# Transcript 会话 UUID 实施计划

**Goal:** 让 ELK 快照顶层 `sessionId` 保存 transcript UUID，并以 `sessionKey` 保留 runtime key。

**Architecture:** 独立 resolver 从 runtime key 定位对应 agent 的 `sessions.json`，解析结果在日志管线准入和 fingerprint 计算前注入。快照组装只负责字段清洗，并继续用 runtime key 收集 recent events。

**Tech Stack:** Electron Main、TypeScript、Node.js `fs/promises`、Vitest。

## Global Constraints

- 只修改 `dev` 分支当前工作区，不创建 worktree。
- 不创建或更新 `docs/`。
- 只接受标准 UUID；解析失败保留 `sessionKey` 并省略 `sessionId`。
- ELK 解析和网络失败不得阻塞 Chat、Gateway 或 Host API 主流程。

### Task 1: 会话上下文 Resolver

**Files:**

- Create: `electron/utils/log-session-context.ts`
- Create: `tests/unit/log-session-context.test.ts`

**Interface:**

```ts
export interface LogSessionContext {
  sessionKey?: string;
  sessionId?: string;
}

export async function resolveLogSessionContext(
  sessionKey: string | undefined,
  options?: { openClawDir?: string },
): Promise<LogSessionContext>;
```

- [x] 先写 `sessionFile` 普通/deleted/reset、`sessionId`/`id` 回退、非法 UUID、缺失索引和 agent 隔离测试。
- [x] 运行 `pnpm exec vitest run tests/unit/log-session-context.test.ts`，确认因模块缺失而失败。
- [x] 实现 agentId 解析、JSON 索引读取、既定优先级和 UUID 校验；任何读取/解析错误只返回 `{ sessionKey }`。
- [x] 重跑 resolver 测试并确认通过。

### Task 2: 快照字段与 Recent Events

**Files:**

- Modify: `electron/utils/error-snapshot.ts`
- Modify: `tests/unit/error-snapshot.test.ts`

**Interface change:** `ErrorSnapshotInput` 和 `ErrorSnapshotDocument` 增加可选 `sessionKey`；`buildErrorSnapshot()` 使用 `input.sessionKey` 收集 recent events。

- [x] 先写失败测试，断言顶层同时输出 UUID `sessionId` 和 runtime `sessionKey`，且 recent event 仍按 runtime key 命中。
- [x] 运行定向测试确认失败原因是缺少 `sessionKey` 支持。
- [x] 最小修改类型、schema validator、字段赋值和 collect 条件。
- [x] 重跑测试并确认通过。

### Task 3: 管线解析与 Fingerprint

**Files:**

- Modify: `electron/utils/log-observability.ts`
- Modify: `tests/unit/log-observability.test.ts`

**Interface change:** `createLogObservabilityPipeline()` 增加可注入的 `resolveSessionContext`，默认使用 `resolveLogSessionContext`。

- [x] 先写失败测试，覆盖 UUID 成功注入、失败时省略 `sessionId`、UUID fingerprint 优先和 `sessionKey` fallback。
- [x] 运行定向测试确认失败。
- [x] 在准入和 fingerprint 前异步解析会话上下文，使用 `sessionId ?? sessionKey ?? ''` 计算 fingerprint。
- [x] 重跑管线测试并确认通过。

### Task 4: Gateway 接入迁移

**Files:**

- Modify: `electron/gateway/manager.ts`
- Modify: `electron/utils/log-observability.ts`
- Modify: `tests/unit/log-observability.test.ts`

- [x] 先更新 lifecycle/RPC 失败测试，要求 capture 输入使用 `sessionKey`，recent event 仍使用 `sessionId` runtime key。
- [x] 运行定向测试确认旧实现失败。
- [x] 将 Gateway RPC 和 lifecycle 快照调用从 `sessionId: runtimeKey` 改为 `sessionKey: runtimeKey`；tracked-run 回调继续使用 runtime key。
- [x] 重跑相关测试并确认通过。

### Task 5: 验证与规格收尾

- [x] 运行 ELK 定向 Vitest 与定向 ESLint。
- [x] 运行 `openspec validate lyclaw-elk-log --strict` 和 harness validate。
- [x] 运行 `pnpm run comms:replay`、`pnpm run comms:compare`、`pnpm run typecheck`、`pnpm run build:vite`。
- [x] 更新 `openspec/changes/lyclaw-elk-log/tasks.md` 的 9.x 状态并执行 `git diff --check`。
