import type { IncomingMessage, ServerResponse } from 'http';
import { mergeUiState, normalizeUiState, readUiState, writeUiState, type LyclawUiState } from '../../utils/ui-state';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

export async function handleUiStateRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  _ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/ui-state' && req.method === 'GET') {
    sendJson(res, 200, { success: true, state: readUiState() });
    return true;
  }

  if (url.pathname === '/api/ui-state' && req.method === 'PUT') {
    try {
      const body = await parseJsonBody<Partial<LyclawUiState> & { state?: Partial<LyclawUiState> }>(req);
      const patch = body.state ?? body;
      const current = readUiState();
      const merged = mergeUiState(current, normalizeUiState(patch));
      const saved = writeUiState(merged);
      sendJson(res, 200, { success: true, state: saved });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
