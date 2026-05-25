"""
领益百事通 WebSocket 流式查询客户端
用法: python ws_stream.py <ws_url> <question> [output_file]

支持对钉钉 dingtalk:// 链接（.docx 结尾）进行 URL 解码，
拼接为 http://10.0.99.18:9000/img-bed/ 完整路径。
"""
import asyncio
import json
import re
import sys
from urllib.parse import unquote


def extract_dingtalk_links(text):
    """从文本中提取 content= 参数值（.docx 结尾的 dingtalk 链接），生成 HTTP 文件链接"""
    # 匹配 content= 参数值，以 .docx 结尾（无论前面是什么）
    pattern = r'content=([^&\s]+\.docx)'
    matches = re.findall(pattern, text)
    
    http_links = []
    for match in matches:
        decoded_path = unquote(match)
        http_url = f"http://10.0.99.18:9000/img-bed/{decoded_path}"
        http_links.append((decoded_path, http_url))
    
    return http_links


def extract_original_dingtalk_links(text):
    """提取完整的 dingtalk:// 原始链接"""
    # 匹配完整的 dingtalk:// 链接
    pattern = r'(dingtalk://[\S]+)'
    matches = re.findall(pattern, text)
    return matches


def process_response(text):
    """处理响应文本，检测并添加 HTTP 下载链接"""
    http_links = extract_dingtalk_links(text)
    original_links = extract_original_dingtalk_links(text)
    
    if not http_links:
        return text, [], []
    
    processed = text
    # 不添加下载链接到响应文本
    
    return processed, http_links, original_links


async def main():
    if len(sys.argv) < 3:
        print("用法: python ws_stream.py <ws_url> <question> [output_file]", file=sys.stderr)
        sys.exit(1)

    ws_url = sys.argv[1]
    question = sys.argv[2]
    out_path = sys.argv[3] if len(sys.argv) > 3 else None

    try:
        import websockets
    except ImportError:
        print("[错误] 请先安装: uv pip install websockets", file=sys.stderr)
        sys.exit(1)

    try:
        async with websockets.connect(ws_url) as ws:
            await ws.send(json.dumps({"question": question}))

            full_text = ""
            async for msg in ws:
                data = json.loads(msg)
                msg_type = data.get("type")

                if msg_type == "token":
                    token = data.get("token", "")
                    full_text += token

                elif msg_type == "end":
                    elapsed = data.get("processing_time", 0)
                    full_text += f"\n[完成] 耗时: {elapsed}s"
                    break

                elif msg_type == "error":
                    err = f"\n[错误] {data.get('error', '未知错误')}"
                    full_text += err
                    break

            # 处理钉钉链接，生成 HTTP 下载链接
            processed_text, http_links, original_links = process_response(full_text)
            
            # 写入文件（避免 stdout GBK 编码破坏中文和链接）
            if out_path:
                with open(out_path, "w", encoding="utf-8") as f:
                    f.write(processed_text)
            else:
                default_path = r"C:\Users\du.ben.ran\.openclaw\workspace\ws_response.txt"
                with open(default_path, "w", encoding="utf-8") as f:
                    f.write(processed_text)

            # 如果有 HTTP 链接，输出到 stderr 供调用者使用
            if http_links:
                links_json = [{"original_link": orig, "path": path, "download_url": url}
                              for orig, (path, url) in zip(original_links, http_links)]
                print(json.dumps(links_json, ensure_ascii=False), file=sys.stderr)

    except Exception as e:
        err_msg = f"\n[错误] {e}"
        if out_path:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(err_msg)
        else:
            with open(r"C:\Users\du.ben.ran\.openclaw\workspace\ws_response.txt", "w", encoding="utf-8") as f:
                f.write(err_msg)


if __name__ == "__main__":
    asyncio.run(main())