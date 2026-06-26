---
id: settle-hung-tool-runs-with-watchdog
title: 为挂起工具调用和后台进程增加生命周期看门狗
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 为所有运行时工具调用、后台 exec/process handle、internal heartbeat run 建立统一生命周期收敛机制；所有资源最终都必须收敛为 completed、failed、timeout、cancelled 或 kill_failed，避免工具挂起后 Chat UI 长时间停留在“思考中”，也避免用户会话结束后后台资源继续泄漏。
touchedAreas:
  - electron/gateway/manager.ts
  - electron/gateway/event-dispatch.ts
  - electron/gateway/session-lock-recovery.ts
  - electron/api/routes/gateway.ts
  - electron/main/ipc-handlers.ts
  - electron/runtime/tool-run-registry.ts
  - electron/runtime/internal-heartbeat.ts
  - src/lib/host-api.ts
  - src/lib/api-client.ts
  - src/stores/chat/types.ts
  - src/stores/chat/runtime-event-handlers.ts
  - src/stores/chat/runtime-send-actions.ts
  - src/stores/chat/runaway-tool-observer.ts
  - tests/unit/chat-event-dedupe.test.ts
  - tests/unit/chat-runtime-send-actions.test.ts
  - tests/unit/chat-tool-lifecycle-watchdog.test.ts
  - tests/unit/gateway-empty-final-diagnostics.test.ts
  - tests/unit/gateway-event-dispatch-internal.test.ts
  - tests/unit/gateway-routes.test.ts
  - tests/e2e/chat-hung-tool-watchdog.spec.ts
expectedUserBehavior:
  - 正常聊天、正常工具调用、正常 final assistant 消息仍然按原流程完成，不额外弹警告。
  - 工具运行超过一个很短的展示阈值后，UI 应明确显示“正在等待某个工具”，而不是只显示泛化的“思考中”。
  - 工具返回 background/running handle 后，当前 run 必须持续跟踪该 handle，直到收到完成、失败、超时或取消的终态。
  - 如果模型显式把命令放入后台执行并给出用户可见 final，UI 可以结束本轮 visible run，但后台 handle 仍必须由 Main/Gateway 继续跟踪和清理。
  - 工具挂起不能让 chat run 永久 active；达到配置的硬超时或空闲超时后，系统必须优先把结构化工具失败结果回灌给模型，让模型换工具、换方案、重试或向用户解释。
  - 只有当模型无法继续、run 已不可恢复、或注入工具失败结果失败时，UI 才以可见的工具超时错误收敛，并给出清晰的下一步操作。
  - 用户在工具运行中点击停止时，active tool 必须被取消或隔离，UI 必须退出思考状态。
  - 工具超时后，最后一条用户消息和既有 transcript 记录必须保留；用户可以手动重试，但系统不能自动重放上一条消息。
  - empty final recovery 和 stale session recovery 仍然保留，但工具挂起/工具超时必须作为独立诊断，不应混同为 stale session。
  - Renderer 继续通过 Main-owned host API 获取状态；不能直接读取 transcript 文件，也不能直接请求 Gateway HTTP endpoint。
  - 用户可见会话 final 后，后台工具完成触发的 internal heartbeat 不能把 `[OpenClaw heartbeat poll]`、`HEARTBEAT_OK`、内部 thinking 或内部 `process` 工具调用显示到 Chat UI 或执行关系图。
  - 工具超时、用户停止或 internal heartbeat 超时后，底层进程、MCP request 或 plugin job 必须被取消、kill、remove 或进入可审计的 kill_failed 状态，不能只让 UI 停止转圈。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/settle-hung-tool-runs-with-watchdog.md
  - pnpm exec vitest run tests/unit/chat-tool-lifecycle-watchdog.test.ts tests/unit/chat-runtime-send-actions.test.ts tests/unit/chat-event-dedupe.test.ts tests/unit/gateway-empty-final-diagnostics.test.ts tests/unit/gateway-event-dispatch-internal.test.ts tests/unit/gateway-routes.test.ts
  - pnpm exec playwright test tests/e2e/chat-hung-tool-watchdog.spec.ts
acceptance:
  - Runtime 必须有统一的工具生命周期状态模型，至少能表达 pending、running、completed、failed、timeout、cancelled。
  - 工具生命周期状态必须包含 runId、sessionKey、toolCallId、toolName、startedAt、lastProgressAt、timeoutAt、idleTimeoutAt、可选 process/session handle，以及结构化终态 reason。
  - Main/Gateway 必须维护 ToolRunRegistry 或等价结构；每个工具调用、background handle、internal heartbeat 工具调用都必须登记 owner、handle、timeout、状态和清理结果。
  - ToolRunRegistry 必须能按 runId、sessionKey、toolCallId、process sessionId、pid 查询 active/terminal 工具记录。
  - 即使工具命令、MCP server 或插件自身没有声明 timeout，工具调用外层也必须有 Main/Gateway 拥有的硬超时。
  - 工具调用必须有空闲超时；依据是 stdout/stderr/progress/runtime event 长时间无更新。空闲超时和绝对硬超时是两个独立条件。
  - 默认 timeout 值要保守，并可通过 Main/Gateway 配置调整；测试中必须能覆盖 timeout 配置。
  - 既有命令安全策略、权限确认策略仍然必须在工具启动前执行。
  - 返回 background/running handle 的工具结果不能被当成成功完成的最终 tool result。
  - 用户可见 assistant final 不能把同一 run 下仍处于 running/background 的工具记录标记为 completed；只有真实工具终态、process completion、明确 cancel 或 registry timeout 才能结束该工具记录。
  - 如果 tool result 是 `status: running`，即使它出现在 `state=final` 事件里，也必须先登记为 active tool/background process，而不是因为事件 state 是 final 就忽略。
  - running handle 必须由 Gateway/Main 通过订阅、轮询或进程跟踪来 reconcile，直到观察到终态。
  - reconcile 过程必须为 completed、failed、timeout、cancelled 结果发出结构化终态工具事件。
  - 如果无法订阅某类工具 runner，必须降级为有上限、有 backoff、有硬截止时间的轮询。
  - 工具硬超时不能只收敛 UI；必须尝试释放底层资源：exec/process 要 kill/remove handle，MCP request 要 cancel/close，plugin job 要调用取消接口或隔离。
  - 底层资源释放结果必须进入结构化终态：cancellationSucceeded=true、false 或 null；释放失败必须进入 kill_failed 或 terminalReason=kill-failed，而不是假装 completed。
  - 工具超时后，主路径必须是把结构化 tool result 注入回当前模型上下文，而不是直接结束 UI；这个 tool result 必须明确告诉模型该工具调用 timeout/cancelled/kill_failed、原因、耗时、是否已清理底层资源。
  - 模型收到工具失败结果后，应被允许继续生成下一步：换工具、换参数、降低范围、重试一次、询问用户、或给出失败解释。
  - 系统必须限制自动重试次数和同类工具连续失败次数，避免模型在同一个坏工具上无限循环。
  - 如果无法把超时结果注入回模型，或模型继续失败达到上限，visible run 才必须用结构化 runError 收敛，错误中要包含 toolName、timeout reason、cleanup result 和用户可采取的操作。
  - 用户主动 abort 时，必须取消或隔离 active tool/process，并记录 cancellationAttempted 和 cancellationSucceeded。
  - safety timeout 触发 abort 时，不能留下未跟踪的子进程或 background tool session。
  - 用户可见 run 已 final 但仍有 background process 时，该 process 必须继续被 ToolRunRegistry 跟踪，直到 completed、failed、timeout、cancelled 或 kill_failed。
  - 用户可见 run 已 final 后，background process 的 timeout/cancel/kill_failed 结果应走 internal/silent 通道；如果需要模型继续处理，必须使用内部控制消息回灌模型，不能把内部控制消息显示给用户。
  - background process 完成后必须自动 remove/cleanup handle；不能依赖用户手动执行 `process remove`。
  - background process 必须有 TTL；超过 TTL 后必须自动 kill/remove，并记录诊断。
  - 每个 session 和全局必须有后台 process 数量上限；超过上限时必须拒绝新后台任务或按策略清理最旧/最低优先级任务。
  - internal heartbeat run 必须标记为 internal/silent；Main/Gateway 应在事件派发层过滤明显 internal heartbeat 事件，Renderer 也必须兜底过滤该 run 的 user prompt、thinking、tool call、tool result、final `HEARTBEAT_OK`，不得作为用户可见消息或执行节点展示。
  - internal heartbeat run 必须有独立短超时；超时后必须 abort，并清理它启动的工具资源。
  - internal heartbeat 默认不得自由调用长耗时工具；如果必须调用工具，只允许使用有白名单、短超时、不可见、可取消的内部工具动作。
  - async command completion 如果 delivery disabled，应由 runtime 直接登记完成和清理 handle；除非确有必要，不应再次调用模型。
  - 如果 internal heartbeat 需要模型参与，system/runtime context 必须强约束输出不可见，并且 renderer 仍需按 internal 标记兜底过滤。
  - internal heartbeat 失败、超时、模型未遵循 `HEARTBEAT_OK` 指令时，必须写结构化 diagnostic，但不能污染用户消息流。
  - Renderer 必须通过既有 runtime event 或 host-api/api-client route 获取 active tool 状态，不能直接读磁盘文件。
  - Renderer 必须按 foreground/background session 保存 activeTool 状态，且不能破坏现有 streamingMessage、streamingTools、pendingFinal、activeRunId 语义。
  - Renderer 只在短阈值之后展示 waiting_tool，避免快速工具调用造成 UI 闪烁。
  - Renderer 在工具 timeout/failure 终态时必须显示 run-level error 或可操作的工具状态，并清理 generic sending/thinking 状态。
  - 错误文案必须区分“模型/Provider 长时间无响应”和“工具调用超时”。
  - 工具超时不能直接触发 stale-session recovery UI；除非另一个 Main 诊断明确证明 session 处于 stale active 状态。
  - empty final confirmation 仍然必须先刷新 history，并能从 transcript-backed assistant output 正常完成。
  - 如果 empty final 发生时仍有 tracked tool active，Renderer 必须保持 waiting_tool/checking 状态，不能立即显示 stale-session recovery。
  - 如果 empty final 发生在 tracked tool 已 timeout 且没有 assistant output 之后，Renderer 必须优先显示工具超时诊断，再考虑 stale session。
  - Gateway diagnostics 必须能按 session 暴露最新 active/hung tool 状态，供调试和恢复判断使用。
  - Gateway diagnostics 必须能暴露 active background process 数量、超 TTL process、kill_failed process 和最近 internal heartbeat 结果。
  - 审计日志必须记录 timeout/cancel/kill/remove/internal-heartbeat 事件，包括 sessionKey、runId、toolCallId、toolName、elapsedMs、idleMs、handle、terminal reason 和 cleanup result。
  - 既有通信策略仍然保持 Main-owned；Renderer 不能在页面/组件中新增直接 Gateway HTTP fetch 或直接 window.electron.ipcRenderer.invoke 调用。
  - 如果改动触及 runtime send/receive、delivery 或 fallback 路径，comms replay 和 compare 仍然适用。
docs:
  required: false
---

## 范围

这个任务解决一类通用问题：助手并不是一直在“思考”，而是某个工具调用没有终态，导致整个 chat run 一直等不到可继续推理的工具结果。

这次触发案例是天气查询命令返回了一个 exec background handle，随后没有产生最终 assistant 回复。但修复不能只针对 weather skill，也不能只靠给某个命令加 `-TimeoutSec`。真正要补的是工具生命周期的主链路。

天气命令可以作为回归用例，但不能作为唯一修复点。

后续测试又暴露了另一个相关问题：用户可见 run 已经 final 后，`exec` 后台进程仍然继续运行；进程完成时 runtime 触发 `[OpenClaw heartbeat poll]`，并把内部 thinking、`process log`、`HEARTBEAT_OK` 显示到了用户执行关系图里。这说明只做 Renderer watchdog 不够，必须同时治理后台资源和 internal heartbeat。

因此本任务的目标不是“让 UI 看起来不转圈”而已，而是：

- UI 不被挂起工具或内部心跳污染。
- Main/Gateway 对所有工具资源有 owner、timeout、取消和清理能力。
- 工具失败首先反馈给模型，让模型有机会换方案继续完成用户目标。
- 后台 process 即使跨越用户可见 run 的 final，也必须最终释放或进入可审计失败状态。

## 第一层：工具执行边界

每一个工具调用都必须被 Main/Gateway 拥有的生命周期边界包住。

这个边界负责：

- 绝对硬超时：工具总运行时间不能无限增长。
- 空闲超时：长时间没有 stdout、stderr、progress 或 runtime event 更新时，判定为卡住。
- 取消能力：用户点击停止、safety timeout、run abort 时，能够取消或隔离 active tool。
- 终态分类：completed、failed、timeout、cancelled。
- 清理终态：底层资源释放成功、释放失败或无需释放必须被明确记录。
- 结构化诊断：记录 runId、sessionKey、toolCallId、toolName、耗时、空闲时长、终态原因。
- 审计日志：timeout/cancel 必须可追踪，方便后续定位。

第一版应优先覆盖 exec 工具，因为这次问题就是 exec 返回 background/running handle 后没有收敛。设计上要能扩展到 MCP tool、plugin tool、browser tool、document tool 等其它工具提供方。

这个边界不能依赖模型自己记得在命令里写 `-TimeoutSec`、`--timeout`、`curl --max-time`。工具自身 timeout 可以作为加分项，但系统外层必须兜底。

硬超时的含义必须明确：到点后不只是把 Renderer 状态改成错误，而是要进入资源清理流程。对于 `exec`/`process`，必须尝试 `kill` 并 `remove` 对应 process handle；对于 MCP/plugin/browser 等其它工具，必须调用对应 cancel/close/cleanup 能力，或把该资源隔离并记录 `kill_failed`/`cleanup_failed`。

如果底层 runner 不支持取消，Main/Gateway 仍然必须记录这一事实，并设置短 TTL 或隔离策略，不能让无法取消的资源无限存在。

## 第二层：ToolRunRegistry 与资源所有权

Main/Gateway 必须维护一个工具运行登记表，作为工具生命周期的权威状态源。

登记表至少要覆盖：

- 用户可见 run 中的普通工具调用。
- 返回 `Command still running` / `status: running` 的后台 exec/process handle。
- internal heartbeat 中启动的内部工具调用。
- Gateway 重启或 renderer 重连后仍能诊断的残留 background handle。

每条记录必须能回答这些问题：

- 这个资源是谁创建的：`owner = user-run | internal-heartbeat | recovery | unknown`。
- 它属于哪个用户 session 和 run。
- 它的底层 handle 是什么，例如 process sessionId、pid、MCP request id、plugin job id。
- 它应该什么时候超时，什么时候因为空闲超时，什么时候因为 TTL 被清理。
- 它现在是否还有底层资源存活。
- 如果已终态，是 completed、failed、timeout、cancelled 还是 kill_failed。

建议结构：

```ts
type ToolRunOwner =
  | 'user-run'
  | 'internal-heartbeat'
  | 'recovery'
  | 'unknown';

type ToolCleanupStatus =
  | 'not-needed'
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'unsupported';

type ToolRunRecord = {
  toolRunId: string;
  owner: ToolRunOwner;
  visible: boolean;
  sessionKey: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  status: ToolLifecycleStatus | 'kill_failed';
  startedAt: number;
  lastProgressAt: number | null;
  timeoutAt: number;
  idleTimeoutAt: number | null;
  ttlExpiresAt: number | null;
  handle?: {
    kind: 'process' | 'exec-session' | 'mcp-request' | 'plugin-job';
    id: string;
    pid?: number;
  };
  cleanup: {
    attempted: boolean;
    status: ToolCleanupStatus;
    attemptedAt: number | null;
    completedAt: number | null;
    error: string | null;
  };
  terminalReason?: string;
};
```

ToolRunRegistry 必须提供下列能力：

- `registerToolRun(record)`：工具启动或发现 running handle 时登记。
- `markProgress(toolRunId, progress)`：收到 stdout/stderr/progress/event 时刷新 lastProgressAt。
- `markTerminal(toolRunId, status, reason)`：工具正常完成、失败或取消。
- `cancelToolRun(toolRunId, reason)`：用户停止、超时、session abort 时取消底层资源。
- `cleanupCompletedToolRun(toolRunId)`：完成后 remove handle。
- `listActiveToolRuns(sessionKey?)`：供 diagnostics 和 renderer 状态使用。
- `reconcileToolRuns()`：按 backoff/TTL/timeout 扫描并收敛残留资源。

## 第三层：Run 继续推理与收敛机制

Agent run 必须理解“工具还在运行”不是“工具成功完成”。

当工具返回 running/background handle 时，正确流程应该是：

1. 当前 run 进入 tracked `waiting_tool` 状态。
2. Gateway/Main 记录 active tool handle。
3. Gateway/Main 通过订阅、进程跟踪或有界轮询来 reconcile 该 handle。
4. 工具完成、失败、超时或取消后，Gateway/Main 发出结构化终态工具事件。
5. 终态结果优先以 tool result 形式注入回当前 run，让模型继续推理。
6. 模型根据结构化失败原因选择换工具、换方法、缩小任务范围、重试一次、询问用户或解释失败。
7. 如果模型无法恢复、连续失败达到上限、或注入失败，visible run 才用结构化 runError 收敛，而不是继续 active。

特别要求：`status: running`、`Command still running`、`sessionId/pid still running` 这类结果不能被当成普通成功 tool result。它们只能代表工具进入后台执行，后续必须由系统追踪。

如果用户可见 run 已经 final，但仍有 background handle，run 可以结束，但 ToolRunRegistry 不能结束对该 handle 的跟踪。这个后台资源后续完成、失败、TTL 或被 kill 时，必须走 internal/silent 路径更新状态和清理资源，不能再把它当作新的用户请求显示出来。

这里需要明确区分两个分支：

- 前台阻塞工具：用户目标依赖工具结果，例如查询天气、读取文件、生成内容。`status: running` 不能触发成功 final；系统应保持 waiting_tool，直到工具终态或 timeout 后把失败结果回灌给模型。
- 显式后台任务：模型或用户明确选择后台执行，例如 `background: true` 的长命令。visible run 可以回复“后台任务已启动”并结束，但这个 final 只能结束用户可见对话，不能结束底层 process 生命周期。ToolRunRegistry 仍必须继续跟踪、超时、kill/remove、诊断和必要的 internal feedback。

因此，`assistant final` 和 `tool/process terminal` 是两个不同事件。不能因为同一个 run 收到 assistant final，就把该 run 下的 running/background tool 统一 `markTerminal(completed)`。

结构化工具失败结果建议包含：

```ts
type ToolFailureInjectedResult = {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  isError: true;
  content: Array<{
    type: 'text';
    text: string;
  }>;
  details: {
    status: 'timeout' | 'cancelled' | 'kill_failed' | 'failed';
    reason: 'hard-timeout' | 'idle-timeout' | 'user-cancelled' | 'ttl-expired' | 'cleanup-failed' | 'tool-error';
    elapsedMs: number;
    idleMs: number | null;
    cleanupAttempted: boolean;
    cleanupSucceeded: boolean | null;
    retryable: boolean;
    suggestedNextActions: Array<'retry' | 'change-tool' | 'change-parameters' | 'ask-user' | 'explain-failure'>;
  };
};
```

注入给模型的文本必须明确但不冗长，例如：

```text
The exec tool timed out after 120s with no progress. The process was killed successfully. Do not repeat the exact same command. Try a safer bounded command, use another tool, ask the user for confirmation, or explain the failure.
```

如果清理失败，文本必须提示模型不要继续依赖该 handle：

```text
The exec tool timed out and cleanup failed. The previous process handle is unsafe to reuse. Do not poll this handle again. Choose another approach or explain the failure.
```

## 第四层：后台进程与 Internal Heartbeat 治理

后台进程完成后的系统心跳是内部机制，不是用户消息。

当 async command completion 触发时，正确流程应该是：

1. runtime 根据 ToolRunRegistry 找到对应 `ToolRunRecord`。
2. 读取或接收 completion result。
3. 标记该 record 为 completed/failed。
4. 自动 remove/cleanup 底层 process handle。
5. 如果 delivery enabled，再通过正常用户可见通道通知用户。
6. 如果 delivery disabled，只写结构化 diagnostic，不写 visible message。

`[OpenClaw heartbeat poll]`、`HEARTBEAT_OK`、内部 runtime context、内部 thinking 和内部工具调用都必须被标记为 internal/silent。即使底层 runtime 仍然把这些记录写进 transcript，Renderer 也必须按 metadata 或内容兜底过滤，不能显示在 Chat UI 或执行关系图里。

internal heartbeat 必须有更严格的资源上限：

- 单次 internal heartbeat run 默认 timeout 应明显短于用户 run，例如 30 秒。
- internal heartbeat 工具调用默认禁用长耗时工具；如需调用 `process log/poll/remove`，必须使用短 timeout。
- internal heartbeat 不允许启动新的 background exec。
- internal heartbeat 触发的工具也必须登记在 ToolRunRegistry，并继承 internal owner。
- internal heartbeat 超时或失败时，必须 abort 该 internal run 并清理其工具资源。
- 如果模型没有遵守 “reply HEARTBEAT_OK only”，Renderer 仍不得显示该输出，Gateway/Main 应记录模型未遵循内部协议的 diagnostic。

后台 process 需要 TTL 和配额：

- 单个后台 process 必须有 TTL。TTL 到期后自动 kill/remove。
- 每个 session 必须有最大后台 process 数量。
- 全局必须有最大后台 process 数量。
- 达到上限时，系统必须拒绝新后台 process、要求用户确认，或按明确策略清理最旧的可清理 process。
- 已 completed/failed/cancelled 的 process handle 必须尽快 remove，避免 process manager 越积越多。

## 第五层：Renderer 与用户恢复

Renderer 的职责是展示真实等待状态，但不能拥有通信和协议切换策略。

UI 应该做到：

- 快速工具调用不展示额外状态，避免闪烁。
- 工具超过短阈值后展示 `waiting_tool`，显示 toolName、elapsed time，可选显示最后进展时间。
- 用户点击 Stop Run 时，同时停止 active run 和 active tool。
- 如果阻塞点是工具，UI 先展示模型仍在基于工具失败继续处理；只有模型无法恢复时，错误文案才说“工具调用超时/已取消”，不要只说“较长时间未收到助手回复”。
- 工具超时后保留用户消息和历史记录。
- 恢复或重试必须由用户手动触发，系统不能自动重发上一条消息。
- internal heartbeat、async completion silent run、`HEARTBEAT_OK` 不展示为用户消息。
- internal run 的 thinking、tool call、tool result 不进入执行关系图。
- 如果底层资源清理失败，Renderer 可以显示一个明确的系统诊断入口或错误状态，但不能把内部心跳 transcript 原样展示出来。

Renderer 必须通过现有 store、runtime event、host-api/api-client 边界拿状态。页面和组件不能新增直接 Gateway HTTP 调用或直接 ipcRenderer 调用。

## 建议验证场景

- 快速成功工具：不出现 waiting_tool UI，assistant final 正常完成。
- 慢但持续有进展的工具：出现 waiting_tool；每次 progress 会刷新 idle timeout；最终正常完成。
- background exec handle 最终完成：run 能 reconcile handle，并最终完成。
- background exec handle 永不完成：工具 timeout 后先注入结构化 tool error，模型换方案或解释失败；只有无法继续时 runError 收敛，UI 退出 thinking。
- 工具进程还活着但长时间无输出：idle timeout 生效，并尝试取消工具。
- 工具 timeout 且 cleanup 成功：模型收到 timeout + cleanupSucceeded=true，不能重复同一危险 handle。
- 工具 timeout 且 cleanup 失败：模型收到 kill_failed/cleanup_failed，不能继续 poll 原 handle。
- 模型收到工具 timeout 后尝试同一工具同一参数无限重试：系统必须触发连续失败上限并收敛。
- 用户在工具运行中点击停止：工具取消被尝试，run 以 user-aborted 状态收敛。
- tracked tool active 时收到 empty final：不能提前显示 stale-session recovery。
- tracked tool timeout 后收到 empty final 且没有 assistant output：优先展示工具超时诊断。
- Gateway 重启时仍有 tracked tool：诊断要说明工具是已取消、丢失 handle，还是可能 stale。
- 用户可见 run final 后后台 exec 继续运行：UI 不再显示 thinking，但 ToolRunRegistry 继续跟踪该 process。
- `status: running` 的 toolResult 出现在 `state=final` 事件中：必须仍登记 active tool/background process；后续 assistant 文本 final 不能把它标记为 completed。
- 模型使用 `background: true` 启动 300 秒命令并立即 final：120 秒 hard timeout 到达后必须 kill/remove 该 process，并通过 internal tool failure feedback 告诉模型该后台任务超时，不能把反馈显示给用户。
- 后台 exec 完成且 delivery disabled：不显示 `[OpenClaw heartbeat poll]`、内部 thinking、`process log`、`HEARTBEAT_OK`；process handle 被自动 cleanup。
- 后台 exec 完成且 delivery enabled：只显示预期的用户可见完成通知，不显示 heartbeat 内部过程。
- internal heartbeat 调用 `process log` 卡住：internal heartbeat 超时，工具被取消/kill，UI 不被污染。
- internal heartbeat 模型没有遵守 `HEARTBEAT_OK only`：输出被静默过滤，记录 diagnostic。
- background process 超过 TTL：自动 kill/remove，状态进入 timeout/cancelled 或 kill_failed。
- 单 session 后台 process 超过上限：新后台任务被拒绝或触发清理策略，并记录用户可理解的错误。
- kill/remove 失败：状态进入 kill_failed，diagnostics 能看到 pid/sessionId/error。

## 非目标

- 不通过只修改 weather skill 来解决。
- 不把“提示模型给命令加 timeout”作为唯一机制。
- 不新增 Renderer-owned 协议切换、Gateway HTTP 直连或页面级 IPC。
- 不在 hung-tool 处理里直接删除 transcript lock 或 session state；这类磁盘状态恢复必须走单独的 stale-session recovery spec。
- 工具超时或恢复后，不自动重发用户上一条消息。
- 不把 internal heartbeat 当成普通用户消息来展示。
- 不把“Renderer 过滤掉 UI”视作资源释放；底层清理必须由 Main/Gateway/runtime 完成。
- 不要求第一版覆盖所有第三方插件取消能力；但不支持取消的插件必须被记录为 unsupported cleanup，并有 TTL/隔离策略。

## 建议结果结构

```ts
type ToolLifecycleStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'kill_failed';

type ToolLifecycleSnapshot = {
  sessionKey: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  status: ToolLifecycleStatus;
  startedAt: number;
  lastProgressAt: number | null;
  timeoutAt: number | null;
  idleTimeoutAt: number | null;
  elapsedMs: number;
  idleMs: number | null;
  handle?: {
    kind: 'process' | 'exec-session' | 'mcp-request' | 'plugin-job';
    id: string;
    pid?: number;
  };
  terminalReason?:
    | 'completed'
    | 'tool-error'
    | 'hard-timeout'
    | 'idle-timeout'
    | 'user-cancelled'
    | 'run-aborted'
    | 'lost-handle'
    | 'ttl-expired'
    | 'kill-failed'
    | 'cleanup-failed'
    | 'internal-heartbeat-timeout';
  message?: string;
};

type ToolTimeoutResult = {
  ok: false;
  errorType: 'tool-timeout';
  sessionKey: string;
  runId: string | null;
  toolCallId: string;
  toolName: string;
  reason: 'hard-timeout' | 'idle-timeout' | 'lost-handle';
  elapsedMs: number;
  idleMs: number | null;
  cancellationAttempted: boolean;
  cancellationSucceeded: boolean | null;
  cleanupAttempted: boolean;
  cleanupSucceeded: boolean | null;
  cleanupError?: string;
  retryable: boolean;
  suggestedNextActions: Array<'retry' | 'change-tool' | 'change-parameters' | 'ask-user' | 'explain-failure'>;
};
```

## 与现有 Spec 的关系

这个 spec 和下面几个已有任务互补：

- `diagnose-and-confirm-empty-chat-final`
- `prevent-runaway-tool-loop-and-stalled-thinking`
- `recover-stale-session-after-empty-final`

诊断优先级建议如下：

1. 如果有 tracked tool 仍 active，优先显示 `waiting_tool`，继续 reconcile。
2. 如果 tracked tool 已 timeout、cancelled、failed 或 kill_failed，优先把结构化工具失败结果注入回模型，让模型继续处理。
3. 如果模型无法继续、注入失败或连续失败达到上限，才展示该工具终态/runError。
4. 如果 run 收到 empty final 且没有 tracked active tool，再走 empty-final confirmation。
5. 如果 empty-final 诊断进一步证明 session stale，才允许展示显式 stale-session recovery 入口。
6. 如果事件来自 internal heartbeat 或 async completion silent run，优先按 internal 规则过滤 UI，再更新 ToolRunRegistry 和 diagnostics。

## 实施拆分建议

建议按以下顺序实现，避免只修 UI 而漏掉资源：

1. 增加 ToolRunRegistry 和结构化状态模型，先覆盖 exec/process。
2. 在 exec 返回 running handle 时登记 process sessionId/pid，并在 completed/failed 后 cleanup。
3. 实现 hard timeout、idle timeout、TTL 和 kill/remove 流程。
4. 实现 timeout/cancel/kill_failed 结果回灌模型，让模型先尝试换方案或解释失败。
5. 增加连续失败和自动重试上限，避免模型在坏工具上循环。
6. 给 `sessions.abort` 和用户 Stop Run 接入 ToolRunRegistry cancellation。
7. 在 Main/Gateway 事件派发层过滤明显 internal heartbeat run，并让 renderer 继续兜底过滤 internal user/thinking/tool/final。
8. 将 async command completion 的 delivery disabled 路径改为直接内部登记和 cleanup，尽量不再调用模型。
9. 增加 Gateway diagnostics 和 harness/e2e 覆盖。

第一版可以只完整覆盖 exec/process，但接口和状态命名必须能扩展到 MCP、plugin、browser 等其它工具。
