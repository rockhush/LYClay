/**
 * DWS (DingTalk Workspace) Environment Setup
 * 
 * Initializes the DWS environment on first launch:
 * 1. Creates ~/.dws directory
 * 2. Sets up default configuration files
 * 3. Ensures required environment structure exists
 * 
 * This runs once at app startup and is idempotent (safe to run multiple times).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { exec, execSync } from 'child_process';
import { app } from 'electron';
import { logger } from './logger';

const DWS_DIR = path.join(os.homedir(), '.dws');

interface DwsConfig {
  version: string;
  createdAt: string;
  updatedAt: string;
  environment: 'production' | 'development';
}

/**
 * Check if DWS environment is already initialized
 */
function isDwsInitialized(): boolean {
  const configFile = path.join(DWS_DIR, 'config.json');
  return fs.existsSync(configFile);
}

/**
 * Initialize DWS environment directory structure
 * Creates:
 *   ~/.dws/
 *   ├── config.json       - DWS configuration
 *   ├── token             - Access token (created on login)
 *   └── cache/            - Cache directory
 */
export async function ensureDwsEnvironmentInitialized(): Promise<void> {
  try {
    // Skip if already initialized
    if (isDwsInitialized()) {
      logger.info('[DwsEnv] DWS environment already initialized, skipping');
      return;
    }

    logger.info('[DwsEnv] Initializing DWS environment...');

    // 1. Create ~/.dws directory
    if (!fs.existsSync(DWS_DIR)) {
      fs.mkdirSync(DWS_DIR, { recursive: true });
      logger.info(`[DwsEnv] Created DWS directory: ${DWS_DIR}`);
    }

    // 2. Create default config.json
    const configPath = path.join(DWS_DIR, 'config.json');
    const config: DwsConfig = {
      version: '1.0.0',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      environment: 'production',
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8' });
    logger.info(`[DwsEnv] Created DWS config: ${configPath}`);

    // 3. Create cache directory
    const cacheDir = path.join(DWS_DIR, 'cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
      logger.info(`[DwsEnv] Created DWS cache directory: ${cacheDir}`);
    }

    // 4. Create .gitignore to prevent token from being committed
    const gitignorePath = path.join(DWS_DIR, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      const gitignoreContent = [
        '# DWS sensitive files',
        'token',
        '*.key',
        '*.secret',
        '',
        '# Cache',
        'cache/',
        '',
      ].join('\n');
      fs.writeFileSync(gitignorePath, gitignoreContent, { encoding: 'utf-8' });
      logger.info(`[DwsEnv] Created .gitignore: ${gitignorePath}`);
    }

    logger.info('[DwsEnv] DWS environment initialization completed');
  } catch (error) {
    logger.error('[DwsEnv] Failed to initialize DWS environment:', error);
    // Don't throw - this is non-critical for app startup
  }
}

/**
 * Get the path to DWS directory
 */
export function getDwsDir(): string {
  return DWS_DIR;
}

/**
 * Get the path to DWS token file
 */
export function getDwsTokenPath(): string {
  return path.join(DWS_DIR, 'token');
}

/**
 * Get the path to DWS config file
 */
export function getDwsConfigPath(): string {
  return path.join(DWS_DIR, 'config.json');
}

/**
 * Get the path to DWS CLI binary
 */
export function getDwsCliPath(): string {
  const binName = process.platform === 'win32' ? 'dws.exe' : 'dws';

  const userInstalledPath = path.join(DWS_DIR, binName);
  if (fs.existsSync(userInstalledPath)) {
    return userInstalledPath;
  }

  // Packaged fallback for older installs or failed extraction.
  if (app?.isPackaged) {
    return path.join(process.resourcesPath, 'dws', binName);
  }
  
  // In development, DWS CLI is in ~/.dws
  return userInstalledPath;
}

/**
 * Execute a DWS CLI command with the full binary path
 * This ensures the command works even if ~/.dws is not in PATH
 * (e.g., in non-interactive shells like child_process.exec)
 * 
 * @param args - Command arguments (e.g., ['calendar', '--date', 'tomorrow'])
 * @param options - execSync options
 * @returns Command output
 */
export function execDwsCommand(args: string[], options?: { encoding?: BufferEncoding }): string {
  const dwsPath = getDwsCliPath();
  const command = `"${dwsPath}" ${args.join(' ')}`;
  
  return execSync(command, {
    encoding: 'utf-8',
    ...options,
  });
}

/**
 * Execute a DWS CLI command asynchronously with the full binary path
 * 
 * @param args - Command arguments
 * @param options - exec options
 * @returns Promise with command output
 */
export async function execDwsCommandAsync(args: string[], options?: { encoding?: BufferEncoding }): Promise<string> {
  const dwsPath = getDwsCliPath();
  const command = `"${dwsPath}" ${args.join(' ')}`;
  
  return new Promise((resolve, reject) => {
    exec(command, { encoding: 'utf-8', ...options }, (error: Error | null, stdout: string, _stderr: string) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}
