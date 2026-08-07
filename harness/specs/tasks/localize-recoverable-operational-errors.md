---
id: localize-recoverable-operational-errors
title: 为可恢复运行错误提供中文操作引导
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 在不改变聊天状态机、定时任务调度或安全策略的前提下，将已知的运行错误转换为友好的本地化提示，并引导用户重试、停止、重启或新建会话。
touchedAreas:
  - harness/specs/tasks/localize-recoverable-operational-errors.md
  - src/pages/Chat/index.tsx
  - src/pages/Chat/ChatMessage.tsx
  - src/pages/Chat/execution-step-presentation.ts
  - src/pages/Chat/task-visualization.ts
  - src/stores/chat/error-presentation.ts
  - src/stores/chat/helpers.ts
  - src/lib/cron-error-i18n.ts
  - src/components/skills/UploadSkillDialog.tsx
  - src/pages/Skills/index.tsx
  - src/pages/Skills/folder-error-presentation.ts
  - src/pages/DigitalEmployee/index.tsx
  - src/pages/DigitalEmployee/install-error.ts
  - src/pages/DigitalEmployee/uninstall-error.ts
  - src/i18n/locales/en/chat.json
  - src/i18n/locales/zh/chat.json
  - src/i18n/locales/en/cron.json
  - src/i18n/locales/zh/cron.json
  - src/i18n/locales/en/skills.json
  - src/i18n/locales/zh/skills.json
  - tests/unit/chat-error-presentation.test.ts
  - tests/unit/execution-step-presentation.test.ts
  - tests/unit/skill-folder-error-presentation.test.ts
  - tests/unit/chat-page-execution-graph.test.tsx
  - tests/unit/chat-suppressed-run-error.test.ts
  - tests/unit/cron-error-i18n.test.ts
  - tests/unit/digital-employee-uninstall-error.test.ts
  - tests/unit/digital-employee-install-error.test.ts
  - tests/unit/upload-skill-dialog-permissions.test.tsx
  - tests/e2e/fixtures/electron.ts
  - tests/e2e/operational-error-guidance.spec.ts
  - tests/e2e/skill-upload-permission-review.spec.ts
expectedUserBehavior:
  - Skill 安全检查阻断安装时，用户看到中文原因和修正后重试的引导，原始错误仅保留在日志中。
  - 模型工具调用流格式异常且静默重试仍失败时，用户看到重试或新建会话的建议。
  - 定时任务在模型调用阶段超时时，提示用户稍后点击“立即运行”重试。
  - 隔离智能体在 runner 启动前超时时，提示用户手动重试，持续失败时重启应用。
  - Windows 文件占用导致数字员工卸载失败时，提示停止相关任务或关闭占用程序后重试。
  - 空 final 的会话确认、恢复、失败和 stale 状态均显示本地化提示，并保留已有恢复、停止和新建会话操作。
  - 模型长时间无输出时，提示本次运行已结束并建议重试或新建会话。
  - 出站图片或附件失败且没有可见回复时显示重新上传提示；已有可见回复时继续按现有规则抑制伪失败。
  - 常见 Cron、目标更新、设备节点、消息、Skill Workshop、Canvas 和回复生成失败在执行图中显示固定的中文原因与用户操作。
  - 已完成的 Run Enabled 状态不在执行图中显示，失败状态仍然保留。
  - Write、Nodes、Apply Patch、Message、Cron、Exec 和 Canvas 工具失败在运行尚未成功结束时保留；运行产生明确成功结果后不再显示。
  - Browser、命令执行、网关重启、HTTP 400 投递和智能体无法生成回复均显示固定的原因与用户操作。
  - 技能目录不在授权范围内时隐藏内部授权错误并提示用户从授权工作区打开或重新安装。
  - 数字员工安装包条目过多时提示清理非必要文件并重新打包。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/localize-recoverable-operational-errors.md
  - pnpm exec vitest run tests/unit/chat-error-presentation.test.ts tests/unit/chat-page-execution-graph.test.tsx tests/unit/chat-suppressed-run-error.test.ts tests/unit/cron-error-i18n.test.ts tests/unit/digital-employee-install-error.test.ts tests/unit/digital-employee-uninstall-error.test.ts tests/unit/execution-step-presentation.test.ts tests/unit/skill-folder-error-presentation.test.ts tests/unit/upload-skill-dialog-permissions.test.tsx
  - pnpm exec playwright test tests/e2e/operational-error-guidance.spec.ts
  - pnpm exec playwright test tests/e2e/skill-upload-permission-review.spec.ts
acceptance:
  - 原始聊天错误在状态机判定完成前保持不变，不得因本地化改变 fatal、recoverable、abort、empty-final 或 tool-stream 分类。
  - 不自动重放上一条聊天消息，不自动重新执行定时任务，不自动重复卸载或上传。
  - 已有一次静默工具调用流重试、空 final 诊断和安全恢复边界保持不变。
  - 已有可见助手回复时继续抑制 outbound media path 伪失败；没有可见回复时必须展示友好中文提示。
  - 页面和组件不新增直接 IPC 或 Gateway HTTP 调用。
  - 完整原始错误继续写入现有日志或 console 诊断，主界面不泄露 Windows 用户目录或内部路径。
  - 错误语义映射只改变展示，不自动修复、重试或修改任务和服务状态。
  - 仅在助手产生明确成功终态后隐藏指定工具失败；运行中、失败终态或结果不明确时不得隐藏。
  - 通信回放和对比检查必须通过。
docs:
  required: false
---
