---
id: recover-stale-session-after-empty-final
title: 空 final 后恢复残留 active 会话
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为反复出现空 final 且历史中没有助手输出的会话增加一个安全、用户主动触发的恢复路径，处理 stale active 状态或 transcript lock 阻塞新运行的问题。
touchedAreas:
  - electron/gateway/manager.ts
  - electron/gateway/session-lock-recovery.ts
  - electron/api/routes/gateway.ts
  - src/lib/host-api.ts
  - src/lib/api-client.ts
  - src/stores/chat/types.ts
  - src/stores/chat/runtime-event-handlers.ts
  - src/stores/chat/runtime-send-actions.ts
  - tests/unit/session-lock-recovery.test.ts
  - tests/unit/chat-event-dedupe.test.ts
  - tests/unit/gateway-empty-final-diagnostics.test.ts
  - tests/unit/gateway-routes.test.ts
expectedUserBehavior:
  - 正常 chat session 继续正常发送和完成，不出现恢复 UI。
  - 如果空 final 可以通过历史刷新拿到结果，仍然按正常完成处理。
  - 如果空 final 后短暂确认窗口内仍没有助手输出，Renderer 先查询 Main 诊断，而不是立刻判定异常。
  - 只有诊断也确认会话没有活跃进展且疑似 stale 时，UI 才显示明确的异常运行状态，并提供恢复入口。
  - 如果诊断显示会话仍可能活跃，例如 transcript/lock 近期更新、Gateway 仍跟踪 active run、或近期有 delta/tool/visible progress，UI 保持等待/确认状态，不提供恢复入口。
  - 当恢复被判定为高置信安全时，用户可以点击“恢复会话”来清理残留状态，然后手动重试。
  - 当恢复不安全时，UI 说明原因，并提供等待、停止运行、新建会话等非破坏性替代方案。
  - 恢复逻辑绝不静默删除另一个仍存活进程持有的锁。
  - 恢复成功后绝不自动重放用户上一条消息；用户需要明确手动重试。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/recover-stale-session-after-empty-final.md
  - pnpm exec vitest run tests/unit/session-lock-recovery.test.ts tests/unit/chat-event-dedupe.test.ts tests/unit/gateway-empty-final-diagnostics.test.ts tests/unit/gateway-routes.test.ts
acceptance:
  - GatewayManager 按 session 保存最近一次 empty-final 诊断，内容包括 runId、sessionKey、时间信息、session store 状态、transcript 文件 stat、lock stat、lock owner pid、lock age、pid 是否存活、恢复跳过原因、当前跟踪中的 active run。
  - Main/host route 可以暴露某个 session 的最新诊断；Renderer 不能直接读文件，也不能直接调用 Gateway HTTP endpoint。
  - Main/host route 可以暴露一个用户主动触发的 stale-session recovery 操作。
  - Renderer 必须通过 `src/lib/host-api.ts` 和/或 `src/lib/api-client.ts` 调用新 host route；组件/页面里不能新增直接 `window.electron.ipcRenderer.invoke(...)` 调用。
  - Renderer 在空 final 后必须先经历“确认中”状态：至少刷新历史、短暂延迟后再刷新一次，并查询 Main 诊断；不能仅凭一次无历史输出就显示异常或恢复入口。
  - Renderer 只有在 Main 诊断确认“无活跃进展且疑似 stale”后，才显示异常运行状态和恢复入口。
  - 如果 Main 诊断显示该 session 仍可能活跃，Renderer 必须继续显示等待/确认状态或提供非破坏性操作（等待、停止运行、新建会话），不能显示会修改磁盘状态的恢复入口。
  - recovery safe mode 只有在所有高置信条件都成立时才允许修改磁盘状态：
    - 同一个 session 最近出现过空 final，并且历史刷新后没有助手输出。
    - session store 状态是 active（`running`、`processing`、`queued` 或 `pending`），或与空 final 结果存在明显冲突。
    - 当前 Gateway 没有跟踪该 session 的 active user run。
    - transcript lock 存在，且 owner pid 已死亡；或者 lock 属于当前 Gateway 且超过 stale 阈值。
    - transcript 和 lock 的 mtime 都早于 stale 阈值。
    - stale 阈值内没有观察到该 session 的 visible progress、delta 或 tool event。
  - 如果 lock 属于另一个仍存活进程，recovery safe mode 必须拒绝修改，并返回类似 `lock-owned-by-live-process` 的 reason。
  - 如果 transcript 或 lock 最近仍在更新，recovery safe mode 必须拒绝修改，并返回类似 `session-recently-active` 的 reason。
  - 如果当前 Gateway 仍跟踪该 session 的 active run，recovery safe mode 必须拒绝修改，并返回 `tracked-active-run`。
  - 恢复成功时，只能删除目标 session 的 stale transcript `.jsonl.lock`，并把 session store entry 标记为终态恢复状态，例如 `status: "error"` 或 `status: "stale-recovered"`，同时写入 `recoveredAt` 和 `recoveryReason`。
  - 恢复成功时必须写审计日志，包含 sessionKey、sessionFile、lockPath、旧状态、新状态、恢复原因和 stale 证据。
  - Renderer 只有在空 final 已确认无助手输出，且 Main 诊断确认疑似 stale 后，才显示恢复入口。
  - 恢复成功后，Renderer 清除异常运行错误，并保留最后一条用户消息；不能自动重新发送。
  - 恢复失败或不安全时，Renderer 显示 Main 返回的 reason，并保留用户消息和历史记录。
  - 后台 session finalization 行为保持不变；最多只允许额外保存诊断，供后续查看。
  - 已有的 `diagnose-and-confirm-empty-chat-final` 空 final 诊断行为保持不变。
  - 所有通信路径变化都必须遵守 Main-owned transport；不能新增 Renderer 侧 Gateway HTTP 调用。
docs:
  required: false
---

## 范围

这个任务是在 `diagnose-and-confirm-empty-chat-final` 已经完成的“观察/确认空 final”能力之后，增加一个恢复路径。

它不应该尝试做大范围自动修复。第一版实现应当保守：只提供明确的、用户主动触发的恢复动作，并且只有在高置信 stale 条件成立时才修改状态。

## 建议流程

1. 用户发送消息。
2. Gateway 返回没有 `message` 的 `final`。
3. Renderer 进入“确认中”状态，刷新历史，短暂延迟后再重试一次。
4. 如果历史刷新拿到新的 assistant/tool 输出，按正常完成处理。
5. 如果仍然没有新的 assistant/tool 输出，Renderer 请求该 session 的最新 Main 诊断。
6. 如果诊断显示会话仍可能活跃，例如近期有文件更新、Gateway 仍有 tracked active run、或近期有 visible progress，Renderer 继续显示等待/确认状态或提供非破坏性操作，不显示恢复入口。
7. 如果诊断显示无活跃进展且疑似 stale，Renderer 进入异常运行状态，并展示恢复入口。
8. 用户点击恢复。
9. Main 重新检查当前磁盘、进程和 Gateway 状态。不能只信任缓存诊断。
10. 如果判定安全，Main 清理 stale lock/state 并返回成功。
11. Renderer 清除异常状态，并提示用户手动重试。

## 非目标

- 第一版不做无用户确认的自动恢复。
- 恢复成功后不自动重发上一条用户消息。
- 不删除另一个仍存活进程持有的锁。
- 不通过历史记录单独推断普通 active run 已完成。
- 不新增 Renderer 侧直接 IPC 或 Gateway HTTP 调用。

## 恢复结果结构

host route 应返回类似下面的结构化结果：

```ts
type SessionRecoveryResult =
  | {
      ok: true;
      recovered: true;
      sessionKey: string;
      previousStatus: string | null;
      nextStatus: string;
      removedLockPath: string | null;
      reason: 'stale-empty-final';
    }
  | {
      ok: true;
      recovered: false;
      sessionKey: string;
      reason:
        | 'missing-diagnostic'
        | 'tracked-active-run'
        | 'lock-owned-by-live-process'
        | 'session-recently-active'
        | 'lock-missing'
        | 'session-entry-missing'
        | 'unsupported-session-key'
        | 'unsafe-state';
      details?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: string;
    };
```

## 建议测试

- `session-lock-recovery.test.ts`：高置信 stale active session 可以被标记为已恢复，并删除 stale lock。
- `session-lock-recovery.test.ts`：lock 属于仍存活的其他 pid 时拒绝恢复。
- `session-lock-recovery.test.ts`：transcript 或 lock 最近更新时拒绝恢复。
- `gateway-empty-final-diagnostics.test.ts`：最新诊断按 session 保存，并且只作为证据使用，不能作为唯一事实来源。
- `chat-event-dedupe.test.ts`：确认过的空 final 只有在 Main 诊断确认疑似 stale 后才展示恢复状态；恢复成功后不会自动重发。
- `chat-event-dedupe.test.ts`：如果 Main 诊断显示会话仍可能活跃，Renderer 保持等待/确认状态，不显示恢复入口。
- route test：diagnostics 和 recover route 校验 sessionKey，使用 Main-owned API，并返回结构化 reason。
