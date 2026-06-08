import type { IncomingMessage, ServerResponse } from 'http';
import { app } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';
import { checkDeviceAccess } from '../../utils/device-access';
import { runOpenClawDoctor, runOpenClawDoctorFix } from '../../utils/openclaw-doctor';

function getIconsDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icons')
    : join(process.cwd(), 'resources', 'icons');
}

function getImageMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.svg') return 'image/svg+xml';
  return 'image/png';
}

export async function handleAppRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/events' && req.method === 'GET') {
    // CORS headers are already set by the server middleware.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    ctx.eventBus.addSseClient(res);
    // Send a current-state snapshot immediately so renderer subscribers do not
    // miss lifecycle transitions that happened before the SSE connection opened.
    res.write(`event: gateway:status\ndata: ${JSON.stringify(ctx.gatewayManager.getStatus())}\n\n`);
    return true;
  }

  if (url.pathname === '/api/app/openclaw-doctor' && req.method === 'POST') {
    const body = await parseJsonBody<{ mode?: 'diagnose' | 'fix' }>(req);
    const mode = body.mode === 'fix' ? 'fix' : 'diagnose';
    sendJson(res, 200, mode === 'fix' ? await runOpenClawDoctorFix() : await runOpenClawDoctor());
    return true;
  }

  if (url.pathname === '/api/app/device-access' && (req.method === 'GET' || req.method === 'POST')) {
    const force = req.method === 'POST';
    sendJson(res, 200, await checkDeviceAccess({ force }));
    return true;
  }

  if (url.pathname === '/api/app/first-response-mascot' && req.method === 'GET') {
    const mascotPath = join(getIconsDir(), 'first-response-mascot.png');
    try {
      const file = await readFile(mascotPath);
      sendJson(res, 200, {
        success: true,
        dataUrl: `data:${getImageMimeType(mascotPath)};base64,${file.toString('base64')}`,
      });
    } catch {
      sendJson(res, 404, {
        success: false,
        error: 'First response mascot image not found',
      });
    }
    return true;
  }

  if (url.pathname === '/api/app/icon' && req.method === 'GET') {
    const requested = url.searchParams.get('name') || '';
    // Allow only a leaf filename inside the bundled icons dir; reject any
    // path separators or traversal attempts.
    const isSafe = /^[A-Za-z0-9._-]+$/.test(requested) && !requested.includes('..');
    if (!isSafe) {
      sendJson(res, 400, { success: false, error: 'Invalid icon name' });
      return true;
    }
    const iconPath = join(getIconsDir(), requested);
    try {
      const file = await readFile(iconPath);
      sendJson(res, 200, {
        success: true,
        dataUrl: `data:${getImageMimeType(iconPath)};base64,${file.toString('base64')}`,
      });
    } catch {
      sendJson(res, 404, { success: false, error: `Icon ${requested} not found` });
    }
    return true;
  }

  // OPTIONS is handled by the server middleware; no route-level handler needed.

  return false;
}
