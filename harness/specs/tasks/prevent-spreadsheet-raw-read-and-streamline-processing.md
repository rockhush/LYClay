---
id: prevent-spreadsheet-raw-read-and-streamline-processing
title: 防止表格文件原始读取并收敛 Excel 处理链路
scenario: gateway-backend-communication
taskType: runtime-bridge
intent: 防止 Excel/CSV 等表格附件被当作原始二进制或纯文本读入聊天上下文，并通过结构化预览与有边界的处理结果，减少 Excel 任务中碎片化的多轮工具调用。
touchedAreas:
  - src/stores/chat.ts
  - src/stores/chat/history-time-decay.ts
  - src/stores/chat/types.ts
  - src/pages/Chat/ChatInput.tsx
  - src/lib/host-api.ts
  - src/lib/api-client.ts
  - electron/api/routes/sessions.ts
  - electron/api/routes/files.ts
  - electron/gateway/*
  - tests/unit/chat-history-time-decay.test.ts
  - tests/unit/spreadsheet-attachment-guard.test.ts
  - tests/e2e/chat-spreadsheet-attachment.spec.ts
expectedUserBehavior:
  - 用户上传 Excel 或 CSV 文件时，聊天应将其视为结构化表格产物，而不是普通文本文件。
  - Agent 不应对 .xlsx、.xls、.xlsm、.xlsb、.ods、.csv、.tsv 等文件走普通 raw read 路径。
  - 如果模型误尝试 raw read 表格文件，工具结果应短小、结构化，并提示改用 spreadsheet preview/processor 路径。
  - 表格预览应展示 sheet 名称、行列规模、表头、样例行、公式/合并单元格信号和告警，不应倾倒完整 workbook XML 或二进制内容。
  - Excel 处理任务应返回有边界的摘要、输出文件路径、校验样例和错误摘要，而不是大段 stdout/DataFrame dump。
  - 长时间运行的表格任务应继续流式展示有效进度；只要仍有进展，常规长任务不应表现得像静默卡死。
requiredProfiles:
  - fast
  - comms
requiredTests:
  - pnpm harness validate --spec harness/specs/tasks/prevent-spreadsheet-raw-read-and-streamline-processing.md
  - pnpm exec vitest run tests/unit/chat-history-time-decay.test.ts tests/unit/spreadsheet-attachment-guard.test.ts
  - pnpm run test:e2e -- tests/e2e/chat-spreadsheet-attachment.spec.ts
acceptance:
  - 表格附件 prompt 包含机器可读的引导信息，明确 raw read 不适合表格文件，应使用结构化表格处理路径。
  - raw read/工具结果过滤能识别 PK\u0003\u0004 等表格二进制特征，并阻止大段二进制/XML 内容进入聊天历史。
  - 大型表格相关工具结果在存储或回放到当前聊天上下文前会被摘要化。
  - spreadsheet preview 路径通过 Main 进程拥有的 API 边界暴露；renderer 页面/组件不直接调用 Gateway HTTP，也不新增 direct ipcRenderer.invoke。
  - 常规 Excel/CSV 任务可以用一次有边界的处理结果完成：输出路径、行数/sheet 数、校验样例、简短诊断。
  - 现有非表格文件读取行为保持不变，仅继续受已有大工具结果保护约束。
  - 单元测试覆盖表格扩展名识别、二进制签名识别、结果截断/摘要、附件 prompt 引导。
  - E2E 覆盖上传 .xlsx 后不会展示原始 ZIP/XML 内容，聊天中出现的是有边界的表格处理响应。
docs:
  required: true
  files:
    - README.md
    - README.zh-CN.md
    - README.ja-JP.md
---

## 问题

最近的聊天日志显示，表格任务里主要有两类相关问题：

1. `.xlsx` 附件可能被普通 `read` 路径直接读取。由于 Excel workbook 本质是 ZIP 容器，这会把二进制 ZIP/XML 内容、乱码和大量无意义 payload 注入模型上下文。
2. Excel 任务经常被拆成很多小的 `write -> exec -> inspect -> write -> exec` 循环。每一轮都可能把冗长中间输出写入 transcript，推高 token 用量，也会让正常长任务看起来像卡住。

实际表现是：上下文增长很快，long-running 诊断变得吓人，模型对表结构的判断变差，transcript 可读性也明显下降。

## 范围

本任务覆盖表格附件和表格相关工具结果的防护与工作流收敛。

本次包含：

- 通过扩展名和二进制签名识别表格文件。
- 增加防护，阻止原始表格内容进入聊天历史。
- 通过 Host API/Main 边界新增或暴露结构化 spreadsheet preview 路径。
- 将表格处理输出限制为简洁摘要和产物路径。
- 增加测试，证明原始 ZIP/XML workbook 内容不会展示或回放。

本次不包含：

- 构建完整电子表格公式引擎。
- 替换所有现有 runtime tool。
- 重写 agent planner。
- 改变 provider/model 选择行为。
- 修复无关的通道重连噪音、MCP 测试 server 配置、plugin symlink 告警。

## 实施计划

### 阶段 1：防止上下文污染

- 增加共享的表格文件检测器，覆盖 `.xlsx`、`.xls`、`.xlsm`、`.xlsb`、`.ods`、`.csv`、`.tsv` 等扩展名。
- 增加 workbook/ZIP 二进制签名检测，尤其是 `PK\u0003\u0004`。
- 更新附件 prompt 构造逻辑，让表格文件携带明确的结构化处理引导。
- 更新大工具结果过滤逻辑，将原始表格二进制/XML dump 替换为简洁诊断信息。
- 确保过滤后的内容才会被回放进模型上下文。

### 阶段 2：结构化 Spreadsheet Preview

- 新增 Main 进程拥有的 Host API route 用于 spreadsheet preview；如果已有安全文件 route，可以复用。
- preview 应返回：
  - 文件名和大小
  - sheet 列表
  - 每个 sheet 的行列规模
  - 检测到的表头
  - 前 N 行样例
  - 公式数量或是否存在公式的标记
  - 在成本可控时返回合并单元格/隐藏 sheet 告警
- Renderer 代码必须通过 `src/lib/host-api.ts` / `src/lib/api-client.ts` 访问。
- 不在 pages/components 中新增 direct `window.electron.ipcRenderer.invoke(...)` 调用。
- Renderer 不直接调用 Gateway HTTP endpoint。

### 阶段 3：收敛表格处理链路

- 将常见 Excel 任务导向一次有边界的处理调用，而不是多轮临时命令循环。
- 标准化 spreadsheet processing result 结构：
  - `success`
  - `outputPath`
  - `sheetsRead`
  - `rowsProcessed`
  - `validationSamples`
  - `warnings`
  - `errors`
  - `summary`
- 对表格任务返回到聊天的 stdout/stderr 做长度限制。
- 需要详细 debug 输出时写入文件，并返回文件路径，而不是把完整日志塞进聊天。
- 对复杂表格转换，优先使用一次生成脚本或参数化脚本执行。

### 阶段 4：进度与诊断

- 在 runtime 支持的位置，为长时间表格任务发出进度标签：
  - 正在读取 workbook
  - 正在检测 sheet
  - 正在处理行
  - 正在写入输出文件
  - 正在校验结果
- 保留 long-running 诊断，但要确保正常进度事件可见，让用户能区分“慢任务”和“卡死”。

## 验证说明

测试中使用一个小型 fixture workbook。该 workbook 应包含多个 sheet、中文表头、公式；如果实现成本可控，也包含至少一个合并单元格场景。

关键回归断言很简单：处理表格附件后，可见聊天消息或回放到模型的上下文中，不应出现 `PK\u0003\u0004`、`[Content_Types].xml`、`xl/workbook.xml` 等原始 workbook ZIP/XML 标记。

## 文档说明

只有当用户可见的表格附件行为发生变化时才更新文档。文档应说明：表格文件会作为结构化产物处理，大型中间处理日志会被摘要化，而不是直接完整打印到聊天中。
