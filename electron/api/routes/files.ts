import type { IncomingMessage, ServerResponse } from 'http';
import { dialog, nativeImage } from 'electron';
import crypto from 'node:crypto';
import { extname, join } from 'node:path';
import { homedir } from 'node:os';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { assertPathAllowed } from '../../security/path-policy';

const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
};

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function mimeToExt(mimeType: string): string {
  for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
    if (mime === mimeType) return ext;
  }
  return '';
}

function hasPathGlobPattern(filePath: string): boolean {
  return /[*?]/.test(filePath);
}

const OUTBOUND_DIR = join(homedir(), '.openclaw', 'media', 'outbound');

function sendFileRouteError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const isSecurityError =
    message.includes('Sensitive path blocked')
    || message.includes('outside authorized workspaces')
    || message.includes('outside its authorized root')
    || message.includes('Path access denied');
  sendJson(res, isSecurityError ? 403 : 500, {
    success: false,
    error: message,
    ...(isSecurityError ? { code: 'FILE_ACCESS_DENIED' } : {}),
  });
}

async function generateImagePreview(filePath: string, mimeType: string): Promise<string | null> {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const maxDim = 512;
    if (size.width > maxDim || size.height > maxDim) {
      const resized = size.width >= size.height
        ? img.resize({ width: maxDim })
        : img.resize({ height: maxDim });
      return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
    }
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(filePath);
    return `data:${mimeType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export async function handleFileRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/files/stage-paths' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ filePaths: string[] }>(req);
      const fsP = await import('node:fs/promises');
      await fsP.mkdir(OUTBOUND_DIR, { recursive: true });
      const results = [];
      for (const filePath of body.filePaths) {
        const pathInfo = await assertPathAllowed({ path: filePath, capability: 'stage', source: 'api:files:stage-paths' });
        const id = crypto.randomUUID();
        const ext = extname(pathInfo.realPath);
        const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
        await fsP.copyFile(pathInfo.realPath, stagedPath);
        const s = await fsP.stat(stagedPath);
        const mimeType = getMimeType(ext);
        const fileName = pathInfo.realPath.split(/[\\/]/).pop() || 'file';
        const preview = mimeType.startsWith('image/')
          ? await generateImagePreview(stagedPath, mimeType)
          : null;
        results.push({ id, fileName, mimeType, fileSize: s.size, stagedPath, preview });
      }
      sendJson(res, 200, results);
    } catch (error) {
      sendFileRouteError(res, error);
    }
    return true;
  }

  if (url.pathname === '/api/files/stage-buffer' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ base64: string; fileName: string; mimeType: string }>(req);
      const fsP = await import('node:fs/promises');
      await fsP.mkdir(OUTBOUND_DIR, { recursive: true });
      const id = crypto.randomUUID();
      const ext = extname(body.fileName) || mimeToExt(body.mimeType);
      const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
      const buffer = Buffer.from(body.base64, 'base64');
      await fsP.writeFile(stagedPath, buffer);
      const mimeType = body.mimeType || getMimeType(ext);
      const preview = mimeType.startsWith('image/')
        ? await generateImagePreview(stagedPath, mimeType)
        : null;
      sendJson(res, 200, {
        id,
        fileName: body.fileName,
        mimeType,
        fileSize: buffer.length,
        stagedPath,
        preview,
      });
    } catch (error) {
      sendFileRouteError(res, error);
    }
    return true;
  }

  if (url.pathname === '/api/files/thumbnails' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{ paths: Array<{ filePath: string; mimeType: string }> }>(req);
      const fsP = await import('node:fs/promises');
      const results: Record<string, { preview: string | null; fileSize: number }> = {};
      for (const { filePath, mimeType } of body.paths) {
        try {
          if (hasPathGlobPattern(filePath)) {
            results[filePath] = { preview: null, fileSize: 0 };
            continue;
          }
          await fsP.stat(filePath);
          const pathInfo = await assertPathAllowed({ path: filePath, capability: 'read', source: 'api:files:thumbnails' });
          const s = await fsP.stat(pathInfo.realPath);
          const preview = mimeType.startsWith('image/')
            ? await generateImagePreview(pathInfo.realPath, mimeType)
            : null;
          results[filePath] = { preview, fileSize: s.size };
        } catch {
          results[filePath] = { preview: null, fileSize: 0 };
        }
      }
      sendJson(res, 200, results);
    } catch (error) {
      sendFileRouteError(res, error);
    }
    return true;
  }

  if (url.pathname === '/api/files/save-image' && req.method === 'POST') {
    try {
      const body = await parseJsonBody<{
        base64?: string;
        mimeType?: string;
        filePath?: string;
        defaultFileName: string;
      }>(req);
      const ext = body.defaultFileName.includes('.')
        ? body.defaultFileName.split('.').pop()!
        : (body.mimeType?.split('/')[1] || 'png');
      const result = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', body.defaultFileName),
        filters: [
          { name: 'Images', extensions: [ext, 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        sendJson(res, 200, { success: false });
        return true;
      }
      const fsP = await import('node:fs/promises');
      if (body.filePath) {
        const pathInfo = await assertPathAllowed({ path: body.filePath, capability: 'read', source: 'api:files:save-image' });
        await fsP.copyFile(pathInfo.realPath, result.filePath);
      } else if (body.base64) {
        await fsP.writeFile(result.filePath, Buffer.from(body.base64, 'base64'));
      } else {
        sendJson(res, 400, { success: false, error: 'No image data provided' });
        return true;
      }
      sendJson(res, 200, { success: true, savedPath: result.filePath });
    } catch (error) {
      sendFileRouteError(res, error);
    }
    return true;
  }

  return false;
}
