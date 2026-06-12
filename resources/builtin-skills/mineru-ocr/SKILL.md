---
name: mineru-ocr
slug: mineru-ocr
version: 1.0.0
description: 使用内网 MinerU 服务对 PDF、扫描件或图片进行 OCR 文档解析，提取正文、标题、表格、公式等结构化内容；当用户要求 OCR、文字识别、PDF解析、扫描件识别、文档识别、提取文本或识别表格时使用。
metadata: |
  {
    "openclaw": {
      "skillKey": "mineru-ocr",
      "primaryEnv": "MINERU_OCR_URL"
    }
  }
---

# MinerU OCR 技能

## 用途

调用内网 MinerU 2.5 服务对 PDF / 图片文件进行 OCR 解析，返回结构化 block 列表（content_list），支持：
- 纯文本提取（段落 + 标题按序拼接）
- 表格识别（输出 Markdown 表格）
- 公式识别（可选开启）
- 与中介解析智能体或其他下游节点对接

---

## 服务配置

| 项目 | 值 |
|------|----|
| 默认服务地址 | `http://10.120.52.2:10270/file_parse` |
| 环境变量覆盖 | `MINERU_OCR_URL` |
| 超时 | 120 秒（大文件可调高） |
| 支持格式 | PDF、PNG、JPG、JPEG、TIFF、BMP |

---

## 工作流

### 1. 确认文件路径和需求

- 用户提供文件路径（绝对路径或相对路径）
- 询问或推断输出格式：`text`（纯文本）/ `blocks`（结构化 JSON）/ `json`（完整 block JSON）
- 询问是否需要表格识别（默认开启）、公式识别（默认关闭）

### 2. 调用解析脚本

先定位当前 skill 目录，再使用目录内的 `scripts/mineru_ocr.py` 执行解析。不要使用固定安装路径；在 LYClaw/OpenClaw 中，skill 可能位于 `~/.openclaw/skills/<skill-name>`、工作区 `skills/` 或临时插件目录。

优先使用项目内置 `uv`（如 `d:\lycode\lyclaw\resources\bin\win32-x64\uv.exe`），否则使用系统 `python`：

```powershell
# 基础用法（输出 blocks JSON）
python scripts/mineru_ocr.py "<file_path>"

# 无 requests 时临时注入依赖
uv run --with requests python scripts/mineru_ocr.py "<file_path>"

# 提取纯文本并保存
python scripts/mineru_ocr.py "<file_path>" --output text --out-file "result.txt"

# 指定服务地址（优先读取 MINERU_OCR_URL，也可显式传入）
python scripts/mineru_ocr.py "<file_path>" --url "http://<host>:<port>/file_parse"

# 中英双语文档
python scripts/mineru_ocr.py "<file_path>" --lang ch,en

# 关闭表格识别（纯文字文档）
python scripts/mineru_ocr.py "<file_path>" --no-table

# 开启公式识别（理工科文档）
python scripts/mineru_ocr.py "<file_path>" --formula

# 扫描件强制使用 OCR 解析
python scripts/mineru_ocr.py "<file_path>" --parse-method ocr
```

完整参数参考：
```
file_path        必填，文件路径
--url            MinerU 服务地址，默认读取 MINERU_OCR_URL；未配置时使用 http://10.120.52.2:10270/file_parse
--lang           语言，逗号分隔，默认 ch
--table          开启表格识别（默认）
--no-table       关闭表格识别
--formula        开启公式识别
--parse-method   解析方式 auto|txt|ocr，默认 auto；扫描件可尝试 ocr
--output         输出格式 json|text|blocks，默认 blocks
--out-file       结果保存路径，不填则打印到 stdout
--timeout        超时秒数，默认 120
```

### 3. 处理输出

**blocks 格式**（默认）：每个 block 包含 `type` / `text` / `page_idx` / `bbox`，适合传给下游智能体处理。

**text 格式**：纯文本，按页分隔，适合直接展示或总结。

**常用后处理操作**：
- 提取特定页：过滤 `block["page_idx"] == N`
- 提取所有表格：过滤 `block["type"] == "table"`
- 提取标题列表：过滤 `block["type"] == "title"`
- 按页拼接文本：用 `blocks_to_text()` 函数（见脚本内）

### 4. 错误处理

遇到以下情况按对应方式处理：

| 错误 | 处理方式 |
|------|----------|
| 文件不存在 | 提示用户确认路径 |
| 连接超时 | 检查内网是否通，增大 `--timeout` |
| HTTP 4xx/5xx | 检查服务日志，确认文件格式 |
| content_list 为空 | 可能是纯扫描件，尝试 `parse_method=ocr` |
| key 不匹配 | 脚本会自动容错取第一个 key |

---

## 与中介解析节点对接

当作为中介解析智能体的子模块调用时，先用当前 `SKILL.md` 所在目录推导脚本路径，再导入脚本；不要写死用户目录或安装目录：

```python
import sys
from pathlib import Path

skill_dir = Path(__file__).resolve().parent
sys.path.insert(0, str(skill_dir / "scripts"))
from mineru_ocr import call_mineru, blocks_to_text

content_list = call_mineru(file_path="report.pdf")
text = blocks_to_text(content_list)
```

---

## 参考资料

- 详细 API 字段说明：见 `references/api_schema.md`
- 已知踩坑：布尔值必须传字符串 `"true"`/`"false"`，数组用 `json.dumps()` 序列化
