---
name: 领益百事通
description: 领益百事通智能问答技能。当用户提问领益智造公司人事、行政、IT运维、OA、SRM、客服、法务等领益内部流程相关问题时，触发本技能。通过 WebSocket 流式接口连接领益百事通后端 QA 系统，实时流式返回回答。如果未配置 user_id，调用时会询问用户钉钉 ID。
---

# 领益百事通（WebSocket 流式）

## 配置（TOOLS.md）

在 `~/.openclaw/workspace/TOOLS.md` 中添加：

```markdown
### 领益百事通
- ws_url: ws://10.0.99.18:8711/ws/query
- user_id: <你的钉钉 user_id>
```

> `user_id` 可向用户询问。若未配置，调用 skill 时会主动询问。

## 调用流程

1. 检查 TOOLS.md 是否已配置 `user_id`
2. 若无 → **询问用户"请告诉我你的钉钉 ID"**，等待输入后再继续
3. 拼接 WS URL：`ws://10.0.99.18:8711/ws/query?user_id={user_id}`
4. 连接 WS，发送问题，流式输出回答

## WebSocket 消息协议

**连接：** `ws://10.0.99.18:8711/ws/query?user_id={user_id}`

**发送：**
```json
{"question": "如何申请补卡？"}
```

**接收（流式）：**
- `{"type": "token", "token": "***"}` — 回复片段，拼接到完整回答
- `{"type": "end", "processing_time": 1.23}` — 流式结束
- `{"type": "error", "error": "..."}` — 异常

## 钉钉链接检测与文件内容展示

**当返回文本中出现 `dingtalk://` 开头、`.docx` 结尾的链接时，触发以下流程：**

### 1. 链接检测与转换

脚本自动检测文本中的 `content=` 参数值以 `.docx` 结尾的 dingtalk 链接，URL 解码后拼接为 HTTP 下载链接：

```
dingtalk://dingtalkclient/action/jumprobot?...&content=%E6%99%BA%E8%83%BD%E9%97%AE%E7%AD%94-IT%E8%BF%90%E7%BB%B4/AD%E8%B4%A6%E5%8F%B7%E5%AF%86%E7%A0%81%E4%BF%AE%E6%94%B9%E6%95%99%E7%A8%8B.docx

→ http://10.0.99.18:9000/img-bed/智能问答-IT运维/AD账号密码修改教程.docx
```

### 2. 文件下载与内容展示

当检测到 docx 链接时，**自动下载文件并以 markdown 格式展示内容**：

**调用命令：**
```bash
# 下载 docx 文件
curl.exe -s -o "输出路径.docx" "HTTP链接"

# 提取文本（支持标题、段落、表格）
uv run --with python-docx python -c "
from docx import Document
doc = Document('输出路径.docx')
for para in doc.paragraphs:
    text = para.text.strip()
    if not text: continue
    style = para.style.name
    if style.startswith('Heading'):
        level = style.replace('Heading ','')
        print('#' * int(level) + ' ' + text)
    elif style == 'List Bullet':
        print('- ' + text)
    else:
        print(text)
for table in doc.tables:
    print('| ' + ' | '.join(c.text.strip() for c in table.rows[0].cells) + ' |')
    print('| ' + ' | '.join('---' for _ in table.rows[0].cells) + ' |')
    for row in table.rows[1:]:
        print('| ' + ' | '.join(c.text.strip() for c in row.cells) + ' |')
"
```

### 3. 助手完整工作流

**步骤 1** - 调用脚本获取回复并检测文档链接：
```bash
uv run --with websockets python scripts/ws_stream.py <ws_url> <question>
```
脚本会通过 stderr 输出 JSON 数组，包含 `original_link`、`path` 字段。

**步骤 2** - 若检测到 docx 链接，下载并提取内容：
```bash
curl.exe -s -o "输出路径.docx" "HTTP链接"
uv run --with python-docx python extract.py "输出路径.docx"
```

**步骤 3** - 展示内容（如检测到文件）：

| 内容类型 | 说明 | 示例 |
|----------|------|------|
| **原链接** | 钉钉原始链接（dingtalk:// 开头） | `dingtalk://dingtalkclient/action/jumprobot?...` |
| **文件附件** | 下载后的本地文件，通过 MEDIA: 指令展示 | `MEDIA:<本地完整绝对路径>` |

**展示格式（在回复末尾）：**

```
📎 文件链接：
[跳转领益百事通](<原始 dingtalk:// 链接>)
MEDIA:<本地完整绝对路径>
```

## 执行脚本

`scripts/ws_stream.py` — 连接 WS 并流式输出 token，自动处理钉钉链接转换。

**调用方式：**
```bash
uv run --with websockets python scripts/ws_stream.py <ws_url> <question> [output_file]
```

## 注意事项

- user_id 决定后端知识库检索权限，务必准确
- WS 连接失败时输出错误信息，不做超时吞掉
- 钉钉链接格式以 `dingtalk://` 开头、`.docx` 结尾
- docx 文件下载后建议提取文本展示，不直接展示二进制
- **文件路径必须使用完整绝对路径**（如 `C:\Users\du.ben.ran\.openclaw\skills\领益百事通\AD账号密码修改教程.docx`），禁止使用相对路径或截断路径
- 展示文件时必须同时展示两种内容：跳转领益百事通（dingtalk:// 链接）、本地文件附件（通过 MEDIA: 指令展示）
- 使用 markdown 链接格式，不要加文字标签，只显示链接本身