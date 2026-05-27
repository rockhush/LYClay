# 上下文压缩设计方案

## 背景

当前项目已有基础上下文压缩逻辑：当历史消息估算 token 超过固定阈值时，将较早消息总结为一条 system 摘要，并保留最近一段原始消息。

现有固定阈值 `150000` 不适合继续使用。不同模型的 `contextWindow` 差异很大，例如 DeepSeek 的 `contextWindow` 可能只有 13W。固定 150K 会导致压缩触发过晚，实际发送前已经超过模型上下文限制，出现请求失败、隐式截断或质量下降。

因此压缩策略应从“固定阈值”改成“基于当前模型上下文窗口的动态预算”。

## 设计目标

1. 适配不同模型的 `contextWindow`，避免固定 token 阈值失效。
2. 尽量保留最近对话原文，避免摘要丢失短期任务细节。
3. 将较早历史压缩成稳定、可恢复的结构化摘要。
4. 对大型工具结果、日志、文件内容做单独裁剪，避免少数超长消息吃完整个上下文。
5. 压缩失败时可降级，但不能静默丢失重要上下文。
6. 保持实现简单，先在现有发送链路上渐进升级。

## 总体方案

发送给模型的最终上下文由四层组成：

```text
finalMessages =
  system / agent instructions
  + rolling summary
  + important structured state
  + recent raw messages
  + current user message
```

各层职责：

- `system / agent instructions`：原有系统提示、agent 配置、工具说明。
- `rolling summary`：被压缩的历史对话摘要，持续增量更新。
- `important structured state`：当前任务状态、用户明确需求、关键文件、错误、决策等。
- `recent raw messages`：最近若干轮完整原文，保证短期上下文和细节不丢失。
- `current user message`：本次用户输入。

## 动态预算策略

新增一个根据模型 `contextWindow` 计算预算的函数：

```ts
interface ContextBudget {
  contextWindow: number;
  maxInputTokens: number;
  compressionTriggerTokens: number;
  reservedOutputTokens: number;
  reservedSystemTokens: number;
  reservedToolTokens: number;
  recentRawTokens: number;
  summaryTokens: number;
}
```

推荐计算方式：

```ts
const contextWindow = model.contextWindow;

const reservedOutputTokens = clamp(
  Math.floor(contextWindow * 0.08),
  4096,
  32000,
);

const reservedSystemTokens = clamp(
  Math.floor(contextWindow * 0.08),
  4000,
  24000,
);

const reservedToolTokens = clamp(
  Math.floor(contextWindow * 0.06),
  4000,
  20000,
);

const maxInputTokens = Math.floor(
  contextWindow - reservedOutputTokens - reservedSystemTokens - reservedToolTokens,
);

const compressionTriggerTokens = Math.floor(maxInputTokens * 0.75);

const recentRawTokens = clamp(
  Math.floor(maxInputTokens * 0.35),
  12000,
  80000,
);

const summaryTokens = clamp(
  Math.floor(maxInputTokens * 0.12),
  2000,
  20000,
);
```

说明：

- `compressionTriggerTokens` 不能超过 `maxInputTokens`，建议在 70%-80% 时提前触发。
- `reservedOutputTokens` 必须预留，否则长回答或工具调用后续响应容易失败。
- `recentRawTokens` 用于保留最近原文，不建议低于 12K。
- `summaryTokens` 控制 rolling summary 大小，避免摘要无限增长。

以 DeepSeek `contextWindow = 130000` 为例，预算大致为：

```text
contextWindow: 130000
reservedOutputTokens: 10400
reservedSystemTokens: 10400
reservedToolTokens: 7800
maxInputTokens: 101400
compressionTriggerTokens: 76050
recentRawTokens: 35490
summaryTokens: 12168
```

这意味着 DeepSeek 不会等到 150K 才压缩，而是在估算输入历史达到约 76K 时提前压缩。

## 压缩触发条件

压缩不应只看总 token，还要考虑消息数量和距离上次压缩的轮数。

建议条件：

```ts
shouldCompress =
  contextCompressionEnabled &&
  !isInternalExecution &&
  messages.length >= 10 &&
  estimatedHistoryTokens >= compressionTriggerTokens &&
  roundsSinceLastCompression >= 4;
```

如果单条消息或工具结果特别大，即使总历史还没到触发线，也应该先做消息级裁剪。

```ts
shouldTrimLargeMessage = messageTokens > maxSingleMessageTokens;
```

推荐：

```ts
maxSingleMessageTokens = Math.floor(maxInputTokens * 0.18);
```

## Rolling Summary 方案

当前实现每次直接总结待压缩历史。建议改成 rolling summary：

```text
previousSummary + newlyCompressedMessages -> nextSummary
```

每个 session 保存一份压缩状态：

```ts
interface ConversationCompressionState {
  sessionKey: string;
  summary: string;
  summarizedThroughMessageId: string | null;
  summarizedMessageCount: number;
  originalTokenEstimate: number;
  summaryTokenEstimate: number;
  compressionVersion: number;
  updatedAt: number;
}
```

压缩后，消息列表不需要永久替换成 system message；更推荐保存 `compressionState`，发送前由 `contextBuilder` 组装最终上下文。

如果短期内不想大改，也可以先沿用现有方式：

```text
messages = [summarySystemMessage, ...recentRawMessages]
```

但 summary 内容必须来自 rolling summary，而不是每次从零总结。

## 摘要格式

摘要不要只生成 200-400 字自然语言。建议使用稳定 Markdown 结构，便于模型恢复任务状态：

```md
## 用户目标
- ...

## 已确认需求
- ...

## 当前任务状态
- 已完成：...
- 未完成：...
- 阻塞：...

## 关键项目事实
- ...

## 关键文件和位置
- path/to/file.ts:123 — ...

## 重要错误和命令结果
- 命令：...
- 结果：...
- 错误：...

## 用户偏好
- ...
```

摘要 prompt 应明确要求：

- 不要编造未出现的信息。
- 保留文件路径、函数名、错误码、配置名、用户明确选择。
- 删除闲聊、重复确认、无效中间过程。
- 如果旧摘要和新消息冲突，以新消息为准。
- 输出必须控制在 `summaryTokens` 对应的长度内。

## 最近原文保留策略

最近消息必须保留原文，不能全部摘要化。

建议规则：

1. 最近至少 6 轮用户/助手对话完整保留。
2. 如果最近 6 轮超过 `recentRawTokens`，优先裁剪大型 tool result，而不是裁剪用户消息。
3. 用户消息优先级高于 assistant 中间过程。
4. assistant 最终回复优先级高于 thinking、debug 日志、长工具输出。
5. 涉及当前任务的文件 diff、错误栈、用户最后一次纠正必须尽量保留。

## 工具结果裁剪策略

大型工具结果需要在消息级别单独处理。

建议分级：

```text
<= 4K tokens：保留原文
4K - 20K tokens：保留头部、尾部、错误行、文件路径、命令和退出码
> 20K tokens：生成工具结果摘要，原文只保留引用信息
```

裁剪后的格式：

```md
[工具结果已裁剪]
命令：pnpm test
状态：失败
退出码：1
关键输出：
- src/foo.ts:42 TypeError: ...
- tests/foo.test.ts:88 expected ...
省略：约 18000 tokens
```

对不同工具结果可采用不同提取策略：

- 测试输出：保留失败测试名、错误栈、断言差异、退出码。
- 构建输出：保留 error/warning、文件路径、行号。
- 搜索输出：保留命中路径和少量上下文。
- 文件读取：保留用户当前关注范围，长文件用片段引用。

## 发送前 Context Builder

建议新增 `context-builder`，专门负责从完整历史构造最终请求消息。

输入：

```ts
interface BuildContextInput {
  messages: RawMessage[];
  currentUserMessage: RawMessage;
  compressionState: ConversationCompressionState | null;
  modelContextWindow: number;
  systemMessages: RawMessage[];
}
```

输出：

```ts
interface BuildContextResult {
  finalMessages: RawMessage[];
  estimatedTokens: number;
  compressed: boolean;
  trimmedMessageCount: number;
  budget: ContextBudget;
}
```

流程：

```text
1. 根据 model.contextWindow 计算 ContextBudget
2. 将完整消息拆成 current user message 与可压缩历史，不压缩本次用户输入
3. 估算 system messages + 历史消息 + 本次用户消息的 token
4. 对超大 tool result 做消息级裁剪，但保持 tool_use/tool_result 配对合法
5. 如果超过 compressionTriggerTokens，更新 rolling summary
6. 从后向前选择 recent raw messages，直到 recentRawTokens，并避免把一组工具调用拆断
7. 拼接 system messages + summary + recent raw messages + current user message
8. 重新估算 finalMessages token
9. 如果仍超过 maxInputTokens，继续按优先级裁剪 tool result、assistant 中间消息和较早 assistant 回复
10. 最后仍超限时，阻止模型调用并提示用户上下文过大，需要新会话、切换大上下文模型或减少输入
```

## 关键边界条件和常见 Bug

实现时需要额外处理以下边界条件，否则压缩逻辑本身可能引入新问题。

### 1. `maxInputTokens` 必须扣除工具预留

如果预算只扣除 system 和 output，不扣除 `reservedToolTokens`，模型在后续工具调用或结构化输出时仍可能超窗。因此：

```ts
maxInputTokens = contextWindow - reservedOutputTokens - reservedSystemTokens - reservedToolTokens;
```

### 2. 当前用户消息不能被压缩

触发点虽然在用户发送之后，但压缩对象只能是旧历史。本次用户输入、附件说明和用户刚刚粘贴的内容必须完整保留。

如果本次用户消息本身已经超过 `maxInputTokens`，不要尝试摘要后自动发送，应直接提示用户拆分输入或改用文件/附件处理。

### 3. 工具调用消息不能拆坏

很多模型要求 `tool_use` 和 `tool_result` 成对出现，不能只保留其中一半。裁剪 recent raw messages 时必须按消息组选择：

```text
assistant tool_use + tool_result + assistant final
```

如果预算不足以保留完整工具组，优先把整组替换为一条工具结果摘要，而不是只删除某一条。

### 4. 摘要请求本身也要受预算保护

更新 rolling summary 时会额外发起一次模型请求。这个摘要请求也可能因为待摘要历史太长而超限。

因此摘要输入需要 batch 化：

```text
previousSummary + batch(messagesToCompress) -> intermediateSummary
intermediateSummary + nextBatch -> nextSummary
```

每个 batch 都必须小于摘要模型的 `maxInputTokens`。

### 5. 不要把 summary 重复压进 summary

如果当前消息列表里已经有 summary system message，再次压缩时不能把旧 summary 当普通历史再次总结，否则会造成摘要重复、信息漂移和 token 膨胀。

应通过 `ConversationCompressionState.summarizedThroughMessageId` 判断哪些原始消息已经被摘要覆盖。

### 6. 并发发送要加锁

如果用户连续快速发送两条消息，两个压缩流程可能同时更新同一个 session 的 rolling summary。

建议按 `sessionKey` 加压缩锁：同一 session 同一时间只允许一个 context build / compression 流程运行。后发请求等待前一个完成后重新读取最新 state。

### 7. token 估算要留安全余量

当前 token 估算不是模型真实 tokenizer，必须留足安全余量。建议硬保护不要卡到 100%，而是：

```ts
hardLimitTokens = Math.floor(maxInputTokens * 0.95);
```

最终校验使用 `hardLimitTokens`，不是裸 `maxInputTokens`。

### 8. 压缩状态和 UI 历史要分离

不要为了模型请求直接删除 UI 历史。UI 应保留完整消息，模型请求使用 `contextBuilder` 构造出的压缩上下文。

如果短期沿用替换 `messages` 的实现，至少要明确这会影响用户回看历史和后续重新压缩准确性。

## 发送前硬保护

为避免“上下文过大导致模型请求卡住”，最终请求发出前必须做一次硬校验。

触发点应放在用户点击发送后、真正调用模型前：

```text
1. 用户提交本次问题
2. 组装候选上下文：历史消息 + 本次用户消息 + system/tool 预留
3. 按模型 contextWindow 计算预算
4. 必要时压缩旧历史、裁剪大型工具结果
5. 重新估算 finalMessages token
6. 如果仍超过 hardLimitTokens，直接阻止模型调用并提示用户
7. 只有 finalMessages 在安全预算内，才发起模型请求
```

硬保护逻辑：

```ts
const hardLimitTokens = Math.floor(budget.maxInputTokens * 0.95);

if (estimatedFinalTokens > hardLimitTokens) {
  throw new ContextTooLargeError({
    estimatedFinalTokens,
    hardLimitTokens,
    maxInputTokens: budget.maxInputTokens,
    contextWindow: budget.contextWindow,
  });
}
```

产品提示建议：

```text
当前会话上下文过大，自动压缩后仍超过当前模型限制。请开启更强压缩、切换更大上下文模型，或新建会话继续。
```

这条规则优先级高于继续发送请求。宁可明确失败，也不要把超预算请求发给模型，因为超预算请求容易表现为长时间无响应、provider 超时、gateway 卡住或模型隐式截断。

## 降级策略

压缩请求失败时，不应该静默丢失历史，也不应该继续发送超预算请求。

推荐顺序：

1. 将待摘要消息切成更小 batch，重试一次。
2. 仍失败时，保留最近原文并插入明确 system 提示。
3. 重新估算 finalMessages token。
4. 如果仍超过 `hardLimitTokens`，阻止模型调用并提示用户上下文过大。
5. UI 或日志提示用户：较早上下文未进入本次请求。

降级 system message：

```md
[上下文压缩失败。系统仅保留最近对话，较早历史未进入本次请求。]
```

不要使用过于模糊的：

```md
[上文已压缩，若干消息已省略。]
```

因为这会让模型误以为仍有足够上下文。

## 配置建议

现有设置：

```ts
contextCompressionEnabled: true
contextCompressionThreshold: 150000
```

建议改成：

```ts
contextCompressionEnabled: true
contextCompressionMode: 'auto' | 'manual'
contextCompressionTriggerRatio: 0.75
contextRecentRawRatio: 0.35
contextSummaryRatio: 0.12
contextMinRecentTurns: 6
contextMaxSingleMessageRatio: 0.18
```

保留 `contextCompressionThreshold` 作为高级覆盖项：

```ts
contextCompressionThresholdOverride?: number | null
```

当 override 为空时，使用动态预算；只有调试或特殊模型才手动指定。

## 兼容当前代码的渐进落地步骤

### 阶段 1：替换固定阈值

- 新增 `resolveContextBudget(modelContextWindow)`。
- 将当前 `contextCompressionThreshold` 默认逻辑改为动态计算。
- 发送链路使用当前模型的 `contextWindow`，不要再固定 150K。
- 如果拿不到模型窗口，使用安全默认值，例如 128K。
- 最终请求校验使用 `hardLimitTokens = maxInputTokens * 0.95`，给估算误差留安全余量。
- 本次用户消息参与预算估算，但不参与压缩；如果本次用户消息单独超限，直接提示用户拆分输入。

### 阶段 2：改进摘要质量

- 将摘要 prompt 改成结构化 Markdown。
- 摘要输入包含 `previousSummary`。
- 为每个 session 保存 `ConversationCompressionState`。
- 压缩后更新 rolling summary。

### 阶段 3：增加工具结果裁剪

- 新增 `trimLargeToolResults(messages, budget)`。
- 对测试、构建、搜索、读取文件等结果做保守裁剪。
- 优先裁剪 assistant/tool_result，不裁剪用户最新需求。

### 阶段 4：抽出 Context Builder

- 不再在发送前直接修改 `messages` 状态。
- 改为发送前构造 `finalMessages`。
- UI 历史仍保留完整消息，模型请求使用压缩后的上下文。

## 推荐优先实现

优先做阶段 1 和阶段 2。

这两步能解决最关键问题：DeepSeek 13W contextWindow 下固定 150K 阈值触发过晚，同时改善摘要丢上下文的问题。

阶段 3 和阶段 4 可以后续做，因为会牵涉更大范围的发送链路和 UI 历史状态设计。

## 验收标准

1. DeepSeek `contextWindow = 130000` 时，压缩触发线约为 80K-90K，而不是 150K。
2. 200K 模型压缩触发线约为 120K-135K。
3. 32K 模型压缩触发线约为 18K-22K。
4. 最近至少 6 轮对话原文保留。
5. 压缩摘要包含用户目标、当前任务状态、关键文件、错误和未完成事项。
6. 压缩失败时用户和模型都能明确知道较早上下文未进入请求。
7. 压缩后 finalMessages 仍超过 `hardLimitTokens` 时，不发起模型请求，而是明确提示用户上下文过大。
8. 不因为单个大型工具结果导致整体上下文超限。
9. `tool_use` / `tool_result` 配对不会被裁剪破坏。
10. 连续快速发送不会并发写坏同一 session 的 rolling summary。
