/**
 * Migrate legacy Electron userData profiles (ClawX/clawx) into the current app folder.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { logger } from './logger';

function getElectronPath(name: Parameters<typeof app.getPath>[0]): string | null {
  try {
    return app.getPath(name);
  } catch (error) {
    logger.warn(`[user-data-migration] Failed to get Electron path "${name}"`, error);
    return null;
  }
}

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

	let currentUserData: string;
  try {
    currentUserData = app.getPath('userData');
  } catch {
    return;
  }
  if (dirHasContent(currentUserData)) {
    return;
  }

  // Same corruption can affect appData (roaming) on Windows; wrap both in try-catch.
  let roamingRoot: string | null = null;
  try {
    roamingRoot = app.getPath('appData');
  } catch {
    roamingRoot = process.env.APPDATA || null;
  }

  // localAppData is Windows-only; macOS/Linux don't have a separate local app data directory
  // Wrap in try-catch because some Windows users have corrupted profiles where
  // app.getPath('localAppData') throws "Failed to get 'localAppData' path".
  let localRoot: string | null = null;
  if (process.platform === 'win32') {
    try {
      localRoot = app.getPath('localAppData');
    } catch {
      // Fall back to LOCALAPPDATA env var when app.getPath fails
      localRoot = process.env.LOCALAPPDATA || null;
    }
  }
  const localCandidates: string[] =
    localRoot
      ? LEGACY_LOCAL_DIR_NAMES.map((name) => join(localRoot, name))
      : [];
  const roamingCandidates: string[] =
    roamingRoot
      ? LEGACY_ROAMING_DIR_NAMES.map((name) => join(roamingRoot, name))
      : [];

  const candidates = [
    ...roamingCandidates,
    ...localCandidates,
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