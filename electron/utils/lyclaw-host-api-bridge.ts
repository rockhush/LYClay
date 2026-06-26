import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getOpenClawConfigDir } from './paths';

export const HOST_API_BRIDGE_RELATIVE = join('.lyclaw', 'host-api-bridge.json');

export interface LyclawHostApiBridgeFile {
  baseUrl: string;
  token: string;
  updatedAt: string;
}

export function getHostApiBridgePath(): string {
  return join(getOpenClawConfigDir(), HOST_API_BRIDGE_RELATIVE);
}

export async function writeLyclawHostApiBridge(
  baseUrl: string,
  token: string,
): Promise<void> {
  const bridgePath = getHostApiBridgePath();
  await mkdir(join(getOpenClawConfigDir(), '.lyclaw'), { recursive: true });
  const payload: LyclawHostApiBridgeFile = {
    baseUrl: baseUrl.replace(/\/$/, ''),
    token,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(bridgePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}
