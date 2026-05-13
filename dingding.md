# 钉钉共享机器人用户级绑定与会话隔离设计方案

## 1. 背景

当前 LYClaw 已有钉钉 OAuth 登录、钉钉渠道自动配置、BFF 欢迎单聊能力。

现有链路大致为：

```text
用户钉钉 OAuth 登录
  -> Electron Main 保存 dingtalkUser
  -> 自动写入 OpenClaw channels.dingtalk account
  -> 将 dingtalk account 绑定到 main Agent
  -> 进入工作台后调用 BFF
  -> BFF 使用 robot/oToMessages/batchSend 给 userId 发送欢迎语
```

当前实现适合单租户、单机器人、单入口场景，但无法完整表达以下需求：

1. 用户 A 登录后，官方钉钉机器人自动发送欢迎语；如果 A 没有绑定钉钉渠道，则自动将该官方机器人绑定给 A。
2. 用户 A、用户 B 都可以使用官方机器人，但二者会话必须隔离，不能串上下文。
3. 当前只申请一个钉钉应用机器人，A/B 不需要各自去钉钉开发者后台申请机器人。
4. 如果用户 A 已经自己绑定过机器人，需要判断 A 当前绑定的机器人是否与官方机器人一致；如果不一致，需要给 A 追加官方机器人绑定，且 A 自己的机器人和官方机器人互不影响。

## 2. 当前代码现状

### 2.1 钉钉登录

入口：`electron/api/routes/dingtalk.ts`

登录成功后会：

- 将用户信息保存到 `electron-store` 的 `dingtalkUser`。
- 将用户信息同步到 OpenClaw workspace 的 `USER.md`。
- 调用 `runDingTalkChannelProvisionAfterLogin(ctx)` 自动配置钉钉渠道。

当前保存的是“当前本机登录用户”，不是多用户绑定模型。

### 2.2 钉钉渠道自动配置

入口：`electron/utils/dingtalk-auto-provision.ts`

当前逻辑：

1. 从环境变量或默认值读取钉钉应用 `clientId/clientSecret`。
2. 查找 `openclaw.json` 中是否已有相同凭证的 dingtalk account。
3. 如果没有，则创建 `auto-1` 等 account。
4. 将该 account 绑定到 `main` Agent。

关键问题：当前绑定是 `dingtalk:accountId -> main`，不是 `dingUserId -> dingtalk accountId -> sessionKey`。

### 2.3 渠道账号唯一性限制

入口：`electron/utils/channel-config.ts`

当前 `CHANNEL_UNIQUE_CREDENTIAL_KEY` 中：

```ts
dingtalk: 'clientId'
```

保存 dingtalk account 时会阻止相同 `clientId` 被保存到多个 account。

这说明当前模型默认认为：

```text
一个钉钉机器人凭证 = 一个 OpenClaw channel account
```

这点本身合理，但不能直接表达“一个官方机器人共享给多个登录用户”。

### 2.4 BFF 欢迎单聊

入口：`D:\lycode\lyclaw-dingtalk-bff\app\main.py`

BFF 接口：

```text
POST /v1/dingtalk/welcome
{ "user_id": "钉钉用户ID" }
```

BFF 仅负责调用：

```text
robot/oToMessages/batchSend
```

向指定 `user_id` 发送欢迎语。

BFF 当前不维护：

- 用户绑定关系
- 会话 ID
- Agent 路由
- conversationId/openConversationId 映射

## 3. 核心设计目标

本次设计的核心目标是：

```text
一个官方钉钉机器人 account
  -> 共享给多个钉钉登录用户
  -> 每个用户拥有独立绑定记录
  -> 每个用户拥有独立会话路由
  -> 用户自定义机器人与官方机器人互不影响
```

需要避免的错误设计：

```text
A 创建一个 official account
B 再创建一个相同 clientId/clientSecret 的 official account
```

不建议为 A/B 创建多份相同钉钉凭证的 channel account。这样容易导致：

- 违反现有 duplicate credential 限制。
- 多个 account 连接同一个 Stream 机器人，可能重复消费事件。
- 后续路由更难判断哪个 account 是真正入口。

推荐设计：

```text
channels.dingtalk.accounts.lyclaw-official 只保存一份官方机器人凭证

A -> officialAccountId: lyclaw-official -> sessionKey: dingtalk:lyclaw-official:single:A
B -> officialAccountId: lyclaw-official -> sessionKey: dingtalk:lyclaw-official:single:B
```

## 4. 新增数据模型

### 4.1 官方机器人 channel account

继续复用现有 `channels.dingtalk.accounts` 结构，但官方机器人使用稳定 accountId。

建议 accountId：

```text
lyclaw-official
```

示例：

```json
{
  "channels": {
    "dingtalk": {
      "enabled": true,
      "accounts": {
        "lyclaw-official": {
          "enabled": true,
          "clientId": "dingxxx",
          "clientSecret": "xxx",
          "managedBy": "lyclaw",
          "scope": "official-shared"
        },
        "a-custom-bot": {
          "enabled": true,
          "clientId": "dingyyy",
          "clientSecret": "yyy",
          "managedBy": "user",
          "ownerDingUserId": "A_userId"
        }
      }
    }
  }
}
```

说明：

- `lyclaw-official` 是系统官方机器人，仅创建一份。
- A/B 共享该 account。
- 用户自定义机器人仍然可以作为独立 account 存在。
- 官方机器人和用户自定义机器人不可互相覆盖。

### 4.2 用户级绑定表

需要新增用户级绑定模型。可以放在 `openclaw.json` 的 LYClaw 扩展字段中，也可以放在 electron-store 或单独 JSON 文件中。

推荐放在 LYClaw 管理的 metadata 中，避免污染 OpenClaw 标准 channel schema。

建议结构：

```json
{
  "dingtalkUserBindings": {
    "A_userId": {
      "dingUserId": "A_userId",
      "unionId": "A_unionId",
      "officialAccountId": "lyclaw-official",
      "personalAccountIds": ["a-custom-bot"],
      "defaultAccountId": "lyclaw-official",
      "agentId": "main",
      "sessionKey": "dingtalk:lyclaw-official:single:A_userId",
      "createdAt": "2026-05-13T00:00:00.000Z",
      "updatedAt": "2026-05-13T00:00:00.000Z"
    },
    "B_userId": {
      "dingUserId": "B_userId",
      "unionId": "B_unionId",
      "officialAccountId": "lyclaw-official",
      "personalAccountIds": [],
      "defaultAccountId": "lyclaw-official",
      "agentId": "main",
      "sessionKey": "dingtalk:lyclaw-official:single:B_userId",
      "createdAt": "2026-05-13T00:00:00.000Z",
      "updatedAt": "2026-05-13T00:00:00.000Z"
    }
  }
}
```

字段说明：

| 字段 | 说明 |
|------|------|
| `dingUserId` | 钉钉通讯录 userId |
| `unionId` | 钉钉 unionId，用于辅助识别用户 |
| `officialAccountId` | 官方共享机器人 accountId |
| `personalAccountIds` | 用户自己绑定的机器人 accountId 列表 |
| `defaultAccountId` | 当前默认使用的机器人 accountId |
| `agentId` | 消息路由到哪个 Agent，第一阶段可使用 `main` |
| `sessionKey` | 用户级隔离会话 key |
| `createdAt/updatedAt` | 审计与排查使用 |

### 4.3 会话路由 Key

单聊推荐格式：

```text
dingtalk:{accountId}:single:{dingUserId}
```

例如：

```text
dingtalk:lyclaw-official:single:A_userId
dingtalk:lyclaw-official:single:B_userId
```

如果钉钉入站 payload 能拿到 `corpId`，建议加入企业维度：

```text
dingtalk:{accountId}:single:{corpId}:{dingUserId}
```

如果能拿到 `openConversationId`，也可以使用：

```text
dingtalk:{accountId}:{openConversationId}:{dingUserId}
```

原则：

- 不能只用 `accountId`。
- 不能只用 `main`。
- 单聊至少要包含 `dingUserId/senderStaffId`。
- 群聊至少要包含 `openConversationId`。

## 5. 登录后自动绑定流程

### 5.1 目标流程

```text
用户 A 钉钉 OAuth 登录
  -> 获取 A 的 userId/unionId
  -> ensure 官方 dingtalk account 存在
  -> 查询 A 是否已有官方机器人绑定
  -> 如果没有，则创建用户级绑定
  -> 如果 A 有自定义机器人，则保留，不覆盖
  -> 生成或读取 A 的独立 sessionKey
  -> 调用 BFF 给 A 发欢迎语
  -> Gateway 刷新 dingtalk channel
```

### 5.2 伪代码

```ts
async function ensureOfficialDingTalkBindingForUser(ctx, user) {
  const officialAccountId = await ensureOfficialDingTalkAccount(ctx);
  const binding = await getDingTalkUserBinding(user.userId);

  if (!binding) {
    await createDingTalkUserBinding({
      dingUserId: user.userId,
      unionId: user.unionId,
      officialAccountId,
      personalAccountIds: [],
      defaultAccountId: officialAccountId,
      agentId: 'main',
      sessionKey: buildDingTalkSingleChatSessionKey(officialAccountId, user.userId),
    });
    return;
  }

  const personalAccountIds = binding.personalAccountIds ?? [];
  const officialAlreadyBound = binding.officialAccountId === officialAccountId;

  await updateDingTalkUserBinding(user.userId, {
    unionId: user.unionId,
    officialAccountId,
    personalAccountIds,
    defaultAccountId: binding.defaultAccountId || officialAccountId,
    sessionKey: binding.sessionKey || buildDingTalkSingleChatSessionKey(officialAccountId, user.userId),
  });
}
```

### 5.3 与现有函数的关系

当前函数：

```ts
runDingTalkChannelProvisionAfterLogin(ctx)
```

建议调整为：

```ts
runDingTalkChannelProvisionAfterLogin(ctx, user)
```

或者新增更明确的函数：

```ts
runDingTalkUserBindingAfterLogin(ctx, user)
```

职责包括：

1. 确保官方机器人 channel account 存在。
2. 确保当前登录用户拥有官方机器人绑定。
3. 确保当前用户拥有独立 sessionKey。
4. 保留用户已有个人机器人绑定。
5. 触发 Gateway 刷新。

## 6. 用户已有自定义机器人时的处理

### 6.1 场景

用户 A 已经绑定了自己的机器人：

```text
A -> a-custom-bot
```

然后 A 登录系统，系统发现官方机器人是：

```text
lyclaw-official
```

如果两者不一致，不应该覆盖 `a-custom-bot`，而应该追加官方机器人绑定：

```text
A -> personalAccountIds: [a-custom-bot]
A -> officialAccountId: lyclaw-official
```

### 6.2 判断规则

```text
如果 A 的 personalAccountIds 中某个 account 的 clientId/clientSecret 与官方机器人一致
  -> 认为 A 已经绑定官方机器人
否则
  -> 追加 officialAccountId = lyclaw-official
```

更推荐使用稳定 accountId 判断：

```text
officialAccountId === lyclaw-official
```

凭证判断作为兼容旧数据的迁移手段。

### 6.3 互不影响原则

- A 自己的机器人继续使用自己的 accountId、sessionKey。
- 官方机器人使用 `lyclaw-official` accountId、官方 sessionKey。
- 不同 accountId 的消息不能写入同一个 session。

示例：

```text
A 自定义机器人会话：dingtalk:a-custom-bot:single:A_userId
A 官方机器人会话：dingtalk:lyclaw-official:single:A_userId
```

## 7. A/B 会话隔离设计

### 7.1 单官方机器人，多用户隔离

```text
官方机器人 accountId = lyclaw-official

A -> sessionKey = dingtalk:lyclaw-official:single:A_userId
B -> sessionKey = dingtalk:lyclaw-official:single:B_userId
```

虽然 A/B 底层共用同一个钉钉应用机器人，但会话写入不同 sessionKey。

### 7.2 入站消息路由

钉钉用户回复机器人后，OpenClaw dingtalk channel 插件需要按以下顺序解析：

```text
收到钉钉消息
  -> 确认 channel = dingtalk
  -> 确认 accountId = lyclaw-official
  -> 从 payload 提取 senderStaffId/userId
  -> 从 payload 提取 openConversationId/conversationId，如果有
  -> 查询 dingtalkUserBindings[userId]
  -> 得到 sessionKey
  -> 投递到对应 OpenClaw session
```

如果插件只能提供 `accountId`，而不能提供 `senderStaffId/userId` 或 `openConversationId`，则无法可靠实现 A/B 会话隔离。

### 7.3 路由兜底

如果找不到用户绑定：

1. 如果消息中有 `senderStaffId/userId`，自动创建临时绑定。
2. sessionKey 使用 `dingtalk:{accountId}:single:{senderStaffId}`。
3. 记录 warning，便于后续排查。

不建议兜底到 `main` 的固定会话，否则容易造成串话。

## 8. BFF 改造建议

BFF 目前只需要发送欢迎语，可以保持轻量。

但建议扩展请求体，便于日志和后续排查：

```json
{
  "user_id": "A_userId",
  "account_id": "lyclaw-official",
  "binding_id": "dingtalk:A_userId:lyclaw-official",
  "session_key": "dingtalk:lyclaw-official:single:A_userId",
  "title": "可选",
  "text": "可选"
}
```

BFF 第一阶段可以只使用 `user_id/title/text`，其余字段用于日志。

BFF 返回值建议包含 trace 信息：

```json
{
  "ok": true,
  "trace_id": "...",
  "account_id": "lyclaw-official",
  "user_id": "A_userId",
  "dingtalk": {}
}
```

## 9. OpenClaw / Gateway 侧要求

这是防止会话串连的关键。

需要确认或改造 OpenClaw dingtalk channel 插件，使其支持：

1. 入站消息 payload 暴露 `senderStaffId/userId`。
2. 入站消息 payload 暴露 `openConversationId/conversationId`。
3. 路由时可指定 `agentId` 和 `sessionKey`。
4. 不再只按 `channel + accountId` 选择一个固定会话。

如果 Gateway 当前只支持：

```text
channel account -> agent
```

则需要新增：

```text
channel account + external user/conversation -> sessionKey
```

否则即使 LYClaw 记录了用户绑定，实际钉钉消息进入 Runtime 时仍可能串会话。

## 10. 需要修改的 LYClaw 文件

### 10.1 `electron/utils/dingtalk-auto-provision.ts`

建议改造点：

- 增加 `OFFICIAL_DINGTALK_ACCOUNT_ID = 'lyclaw-official'`。
- 将当前 `generateUniqueDingTalkAccountId()` 用于普通用户自定义机器人，不用于官方机器人。
- 新增 `ensureOfficialDingTalkAccount(ctx)`。
- 新增 `ensureDingTalkUserBindingAfterLogin(ctx, user)`。
- 不再无脑调用 `ensureDingTalkAccountBoundToMain(existingAccountId)` 作为用户隔离手段。
- 调用 BFF welcome 时携带 `account_id/binding_id/session_key`。

### 10.2 `electron/api/routes/dingtalk.ts`

当前登录成功后：

```ts
await runDingTalkChannelProvisionAfterLogin(ctx);
```

建议改为：

```ts
await runDingTalkChannelProvisionAfterLogin(ctx, result.user);
```

或：

```ts
await runDingTalkUserBindingAfterLogin(ctx, result.user);
```

### 10.3 新增用户绑定存储工具

建议新增类似：

```text
electron/utils/dingtalk-user-bindings.ts
```

提供：

```ts
getDingTalkUserBinding(userId)
upsertDingTalkUserBinding(binding)
listDingTalkUserBindings()
buildDingTalkSingleChatSessionKey(accountId, userId, corpId?)
findPersonalDingTalkAccountsForUser(userId)
```

存储位置可选：

1. electron-store：适合 LYClaw 本地 UI 管理。
2. `~/.openclaw/lyclaw-dingtalk-bindings.json`：适合 Gateway/插件也读取。
3. `openclaw.json` 扩展字段：集中但要注意 OpenClaw schema 兼容。

推荐：如果 Gateway/插件也需要读取，使用独立 JSON 文件更稳。

### 10.4 `electron/utils/channel-config.ts`

如果采用“一份官方 account + 多用户 binding”，无需放开 dingtalk duplicate credential 限制。

如果后续决定“A/B 在 accounts 中各自创建同凭证 account”，则需要调整 duplicate credential 策略，但不推荐。

### 10.5 BFF 项目 `app/main.py`

建议：

- 扩展 `WelcomeBody`，增加 `account_id/binding_id/session_key` 可选字段。
- 日志中输出这些字段。
- 返回 trace 信息。

BFF 不建议承担核心会话路由，核心路由应在 OpenClaw dingtalk channel/Gateway。

## 11. 实施步骤建议

### 阶段一：LYClaw 侧用户绑定落地

1. 新增用户绑定存储工具。
2. 官方 dingtalk account 使用稳定 accountId `lyclaw-official`。
3. 登录成功后按 `userId` 创建/更新用户绑定。
4. 欢迎语发送时携带 binding/session 信息。
5. 保留用户已有自定义机器人，不覆盖。

验收：

- A 登录后生成 A 的 binding。
- B 登录后生成 B 的 binding。
- A/B 共用同一个 `lyclaw-official` account。
- A 已有自定义机器人时，官方机器人绑定被追加，自定义机器人不丢失。

### 阶段二：Gateway / dingtalk channel 入站路由

1. 确认 dingtalk payload 是否包含 `senderStaffId/userId/openConversationId`。
2. 根据 `accountId + senderStaffId` 查询用户绑定。
3. 将消息写入用户专属 sessionKey。
4. 缺失绑定时自动创建兜底 sessionKey。

验收：

- A 给官方机器人发消息，只进入 A 的 session。
- B 给官方机器人发消息，只进入 B 的 session。
- A/B 同时发消息不串上下文。
- A 的自定义机器人和官方机器人进入不同 session。

### 阶段三：UI 与排查能力

1. 设置页展示当前用户的官方机器人绑定状态。
2. 展示用户自定义机器人和官方机器人是否一致。
3. 提供“重新绑定官方机器人”能力。
4. 日志中打印 `userId/accountId/sessionKey/traceId`。

## 12. 关键风险

### 12.1 如果 dingtalk channel 插件拿不到 senderStaffId

无法可靠按用户隔离，只能按 conversationId 或 accountId 兜底。

如果只按 accountId 兜底，A/B 会串会话。

### 12.2 如果 Gateway 不支持外部会话路由

即使 LYClaw 保存了绑定关系，消息进入 Runtime 时仍可能进入默认会话。

需要 Gateway 支持：

```text
external channel message -> explicit sessionKey
```

### 12.3 如果重复创建同一官方机器人 account

可能导致：

- duplicate credential 报错。
- Stream 重复连接。
- 消息重复消费。
- 路由无法判断归属。

所以官方机器人必须稳定为一份 account。

## 13. 推荐最终形态

```text
LYClaw 官方机器人：
  channels.dingtalk.accounts.lyclaw-official

用户 A：
  binding: A_userId -> lyclaw-official
  session: dingtalk:lyclaw-official:single:A_userId

用户 B：
  binding: B_userId -> lyclaw-official
  session: dingtalk:lyclaw-official:single:B_userId

用户 A 自定义机器人：
  account: a-custom-bot
  session: dingtalk:a-custom-bot:single:A_userId

路由原则：
  accountId + dingUserId/openConversationId -> sessionKey
```

最终要实现的是：

```text
一个官方钉钉应用机器人
  -> 多个用户级绑定
  -> 多个独立 session
  -> 不要求用户自己申请机器人
  -> 不覆盖用户自己的机器人
  -> 不按 main 固定会话混写上下文
```
