#!/usr/bin/env python3
"""
mineru_ocr.py — MinerU 2.5 PDF/图片 OCR 调用脚本
用法:
    python mineru_ocr.py <file_path> [options]

Options:
    --url       MinerU 服务地址，默认读取 MINERU_OCR_URL，未配置时使用 http://10.120.52.2:10270/file_parse
    --lang      语言列表，逗号分隔，默认 ch
    --table     开启表格识别（默认开启）
    --formula   开启公式识别（默认关闭）
    --parse-method  解析方式: auto|txt|ocr，默认 auto
    --output    输出格式: json|text|blocks，默认 blocks
    --out-file  结果保存路径（可选，不指定则打印到 stdout）
    --timeout   请求超时秒数，默认 120

示例:
    python mineru_ocr.py report.pdf
    python mineru_ocr.py scan.pdf --output text --out-file result.txt
    python mineru_ocr.py doc.pdf --url http://192.168.1.10:10270/file_parse --lang ch,en
"""
import argparse
import json
import sys
import logging
import os
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

try:
    import requests
except ImportError:
    print("[ERROR] 缺少 requests 库，请先安装: pip install requests", file=sys.stderr)
    sys.exit(1)

DEFAULT_PARSE_URL = "http://10.120.52.2:10270/file_parse"


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("mineru_ocr")


# ──────────────────────────────────────────────
# 核心调用函数
# ──────────────────────────────────────────────

def call_mineru(
    file_path: str,
    parse_url: str | None = None,
    lang_list: list[str] | None = None,
    table_enable: bool = True,
    formula_enable: bool = False,
    parse_method: str = "auto",
    timeout: int = 120,
) -> list[dict]:
    """
    调用 MinerU 2.5 解析接口，返回 content_list（block 列表）。

    Returns:
        list[dict]: 每个 block 包含 type / text / bbox / page_idx 等字段
    Raises:
        requests.HTTPError: 接口返回非 2xx
        ValueError: 响应中缺少预期字段
    """
    if lang_list is None:
        lang_list = ["ch"]
    parse_url = parse_url or os.environ.get("MINERU_OCR_URL") or DEFAULT_PARSE_URL

    file_path = Path(file_path)
    if not file_path.exists():
        raise FileNotFoundError(f"文件不存在: {file_path}")

    pathstem = file_path.stem

    # multipart/form-data：布尔值用小写字符串，数组用 JSON 字符串
    data = {
        "backend": "vlm-vllm-async-engine",
        "lang_list": json.dumps(lang_list),
        "parse_method": parse_method,
        "table_enable": "true" if table_enable else "false",
        "formula_enable": "true" if formula_enable else "false",
        "return_md": "false",
        "return_content_list": "true",
        "return_middle_json": "false",
        "return_model_output": "false",
        "return_images": "false",
        "response_format_zip": "false",
    }

    log.info(f"正在解析: {file_path.name}  →  {parse_url}")

    with open(file_path, "rb") as f:
        files = {"files": (file_path.name, f, _mime_type(file_path))}
        try:
            resp = requests.post(parse_url, files=files, data=data, timeout=timeout)
            resp.raise_for_status()
        except requests.exceptions.Timeout:
            log.error(f"请求超时（{timeout}s），文件: {file_path.name}")
            raise
        except requests.exceptions.ConnectionError as e:
            log.error(f"无法连接 MinerU 服务: {parse_url}\n{e}")
            raise
        except requests.exceptions.HTTPError:
            log.error(f"HTTP 错误 {resp.status_code}: {resp.text[:300]}")
            raise

    content_type = resp.headers.get("content-type", "")

    # ── ZIP 响应（response_format_zip=true 时触发）──
    if "application/zip" in content_type:
        zip_path = file_path.parent / f"{pathstem}_mineru.zip"
        zip_path.write_bytes(resp.content)
        log.info(f"ZIP 已保存: {zip_path}（共 {len(resp.content)//1024} KB）")
        return []   # ZIP 模式下无内存结果

    # ── JSON 响应 ──
    try:
        parse_result = resp.json()
    except json.JSONDecodeError as e:
        log.error(f"响应非 JSON，前200字符: {resp.text[:200]}")
        raise ValueError("MinerU 返回了非 JSON 响应") from e

    results = parse_result.get("results", {})
    if pathstem not in results:
        available = list(results.keys())
        log.error(f"响应中未找到 key '{pathstem}'，实际 keys: {available}")
        # 尝试容错：取第一个 key
        if available:
            log.warning(f"自动降级：使用第一个 key '{available[0]}'")
            pathstem = available[0]
        else:
            raise ValueError(f"MinerU 响应中没有有效结果，完整响应: {parse_result}")

    raw_content_list = results[pathstem].get("content_list")
    if raw_content_list is None:
        raise ValueError(f"响应中缺少 content_list 字段，entry keys: {list(results[pathstem].keys())}")

    content_list: list[dict] = json.loads(raw_content_list)
    log.info(f"解析完毕: {pathstem}，共 {len(content_list)} 个 block")
    return content_list


# ──────────────────────────────────────────────
# 输出转换工具
# ──────────────────────────────────────────────

def blocks_to_text(content_list: list[dict]) -> str:
    """将 block 列表拼接为纯文本（按页序/行序）。"""
    lines = []
    current_page = -1
    for block in content_list:
        page = block.get("page_idx", 0)
        if page != current_page:
            if current_page != -1:
                lines.append("")  # 页间空行
            lines.append(f"─── 第 {page + 1} 页 ───")
            current_page = page

        btype = block.get("type", "text")
        text = block.get("text", "").strip()
        if not text:
            continue

        if btype == "title":
            lines.append(f"\n【{text}】")
        elif btype == "table":
            lines.append(f"\n[表格]\n{text}\n")
        elif btype == "equation":
            lines.append(f"[公式] {text}")
        else:
            lines.append(text)

    return "\n".join(lines)


def blocks_summary(content_list: list[dict]) -> dict:
    """统计 block 分布。"""
    from collections import Counter
    counter = Counter(b.get("type", "unknown") for b in content_list)
    return dict(counter)


def _mime_type(path: Path) -> str:
    ext = path.suffix.lower()
    return {
        ".pdf": "application/pdf",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".tiff": "image/tiff",
        ".bmp": "image/bmp",
    }.get(ext, "application/octet-stream")


# ──────────────────────────────────────────────
# CLI 入口
# ──────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="MinerU 2.5 OCR 调用工具",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("file_path", help="待解析文件路径（PDF/PNG/JPG）")
    parser.add_argument("--url", default=os.environ.get("MINERU_OCR_URL") or DEFAULT_PARSE_URL,
                        help="MinerU 服务地址，默认读取 MINERU_OCR_URL，未配置时使用内网默认地址")
    parser.add_argument("--lang", default="ch",
                        help="语言，逗号分隔，如 ch 或 ch,en")
    parser.add_argument("--table", action="store_true", default=True,
                        help="开启表格识别（默认开启）")
    parser.add_argument("--no-table", dest="table", action="store_false",
                        help="关闭表格识别")
    parser.add_argument("--formula", action="store_true", default=False,
                        help="开启公式识别")
    parser.add_argument("--parse-method", choices=["auto", "txt", "ocr"], default="auto",
                        help="解析方式（默认 auto；扫描件可尝试 ocr）")
    parser.add_argument("--output", choices=["json", "text", "blocks"], default="blocks",
                        help="输出格式（默认 blocks）")
    parser.add_argument("--out-file", help="结果保存路径（不指定则打印到 stdout）")
    parser.add_argument("--timeout", type=int, default=120, help="超时秒数")

    args = parser.parse_args()
    lang_list = [l.strip() for l in args.lang.split(",") if l.strip()]

    content_list = call_mineru(
        file_path=args.file_path,
        parse_url=args.url,
        lang_list=lang_list,
        table_enable=args.table,
        formula_enable=args.formula,
        parse_method=args.parse_method,
        timeout=args.timeout,
    )

    if not content_list:
        log.warning("结果为空（可能是 ZIP 模式或文件无内容）")
        return

    # 统计摘要
    summary = blocks_summary(content_list)
    log.info(f"Block 分布: {summary}")

    # 输出格式
    if args.output == "json":
        output_str = json.dumps(content_list, ensure_ascii=False, indent=2)
    elif args.output == "text":
        output_str = blocks_to_text(content_list)
    else:  # blocks
        output_str = json.dumps(content_list, ensure_ascii=False, indent=2)

    if args.out_file:
        out_path = Path(args.out_file)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(output_str, encoding="utf-8")
        log.info(f"结果已保存: {out_path}")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        print(output_str)


if __name__ == "__main__":
    main()
