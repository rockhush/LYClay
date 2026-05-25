/**
 * Migrate legacy Electron userData profiles (ClawX/clawx) into the current app folder.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { logger } from './logger';

function dirHasContent(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

const LEGACY_ROAMING_DIR_NAMES = ['clawx', 'ClawX', 'lyclaw', 'LYClaw'];
const LEGACY_LOCAL_DIR_NAMES = ['clawx', 'ClawX', 'lyclaw', 'LYClaw'];

export function migrateLegacyUserDataIfNeeded(): void {
  if (process.env.CLAWX_E2E === '1') return;
  if (process.env.CLAWX_USER_DATA_DIR?.trim()) return;

  const currentUserData = app.getPath('userData');
  if (dirHasContent(currentUserData)) {
    return;
  }

  const roamingRoot = app.getPath('appData');
  const localRoot = app.getPath('localAppData');

  const candidates = [
    ...LEGACY_ROAMING_DIR_NAMES.map((name) => join(roamingRoot, name)),
    ...LEGACY_LOCAL_DIR_NAMES.map((name) => join(localRoot, name)),
  ];

  for (const legacyPath of candidates) {
    if (legacyPath === currentUserData) continue;
    if (!dirHasContent(legacyPath)) continue;

    try {
      mkdirSync(currentUserData, { recursive: true });
      cpSync(legacyPath, currentUserData, { recursive: true, force: true });
      logger.info('[user-data-migration] Copied legacy userData profile', {
        from: legacyPath,
        to: currentUserData,
      });
      return;
    } catch (error) {
      logger.warn('[user-data-migration] Failed to copy legacy userData profile', {
        from: legacyPath,
        to: currentUserData,
        error: String(error),
      });
    }
  }
}
