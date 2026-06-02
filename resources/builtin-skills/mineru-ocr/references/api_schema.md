# MinerU 2.5 API 参考

## 接口信息

| 项目 | 值 |
|------|-----|
| 默认地址 | `http://10.120.52.2:10270/file_parse` |
| 环境变量覆盖 | `MINERU_OCR_URL` |
| 方法 | POST |
| Content-Type | `multipart/form-data` |

---

## 请求字段

### 文件字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `files` | file | 待解析文件，支持 PDF / PNG / JPG / TIFF |

### 参数字段（均为字符串，布尔用 `"true"`/`"false"`）

| 字段名 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `backend` | string | `vlm-vllm-async-engine` | 解析后端，固定值 |
| `lang_list` | JSON array string | `["ch"]` | 语言列表，如 `["ch","en"]` |
| `parse_method` | string | `auto` | 解析方式：`auto` / `txt` / `ocr` |
| `table_enable` | bool string | `"true"` | 是否开启表格识别 |
| `formula_enable` | bool string | `"false"` | 是否开启公式识别 |
| `return_md` | bool string | `"false"` | 返回 Markdown 文本 |
| `return_content_list` | bool string | `"true"` | **必须为 true**，返回结构化 block 列表 |
| `return_middle_json` | bool string | `"false"` | 返回中间 JSON（调试用） |
| `return_model_output` | bool string | `"false"` | 返回模型原始输出 |
| `return_images` | bool string | `"false"` | 返回页面图像 |
| `response_format_zip` | bool string | `"false"` | 以 ZIP 包形式返回所有产物 |

> ⚠️ **重要**：`requests` 的 `multipart/form-data` 不会自动序列化 Python `True`/`False` 和 `list`。  
> 布尔值必须传字符串 `"true"`/`"false"`，数组字段（`lang_list`）必须用 `json.dumps()` 序列化。

---

## 响应格式

### JSON 响应（`response_format_zip=false`）

```json
{
  "results": {
    "<pathstem>": {
      "content_list": "[...]",
      "md_content": "...",
      "middle_json": "..."
    }
  }
}
```

> `pathstem` 为上传文件名去掉扩展名。如文件名为 `report.pdf`，则 key 为 `report`。

### content_list block 结构

```json
[
  {
    "type": "title",
    "text": "第一章 概述",
    "page_idx": 0,
    "bbox": [72, 120, 540, 145]
  },
  {
    "type": "text",
    "text": "本报告...",
    "page_idx": 0,
    "bbox": [72, 160, 540, 200]
  },
  {
    "type": "table",
    "text": "| 列1 | 列2 |\n|-----|-----|\n| A | B |",
    "page_idx": 1,
    "bbox": [72, 300, 540, 450]
  }
]
```

### block type 枚举

| type | 含义 |
|------|------|
| `title` | 标题 |
| `text` | 正文段落 |
| `table` | 表格（Markdown 格式） |
| `figure` | 图片 caption |
| `equation` | 数学公式 |
| `list` | 列表项 |

### ZIP 响应（`response_format_zip=true`）

- Content-Type: `application/zip`
- 包含所有产物：md、content_list.json、images 等
- 适合批量处理落盘场景

---

## 常见错误排查

| 现象 | 原因 | 解决 |
|------|------|------|
| `table_enable` 不生效 | 传了 Python `True` 而非字符串 | 改为 `"true"` |
| 响应中找不到 pathstem key | 文件名含特殊字符 | 重命名文件再上传 |
| 返回 content_list 为空 | 文档是扫描件但 parse_method=txt | 改为 `parse_method=ocr` |
| 连接超时 | 文件过大或服务繁忙 | 增大 timeout 或拆分文件 |
