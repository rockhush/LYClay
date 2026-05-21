/**
 * Token persistence utility for ClawX
 * 
 * Handles saving authentication tokens to:
 * 1. Environment variables (for current process)
 * 2. Local files (for persistence across sessions)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { logger } from './logger';
import { getDwsTokenPath } from './dws-env-setup';

/**
 * Save token to environment variable and local file
 * @param token - The access token to save
 */
export async function saveTokenToEnvAndFile(token: string): Promise<void> {
  try {
    // Method 1: Set environment variable (system-level on Windows)
    process.env['DWS_ACCESS_TOKEN'] = token;
    
    // Also set system-level environment variable on Windows so other processes can access it
    if (process.platform === 'win32') {
      try {
        // Use setx to set user-level environment variable (persists across sessions)
        execSync(`setx DWS_ACCESS_TOKEN "${token}"`, { encoding: 'utf-8' });
        logger.info('[TokenStorage] Set DWS_ACCESS_TOKEN system environment variable (Windows)');
      } catch (error) {
        logger.warn('[TokenStorage] Failed to set system env var with setx:', error);
        // Continue even if system-level set fails
      }
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // On macOS/Linux, we can modify shell profile files
      // This is optional and may require user to restart terminal
      try {
        const shellConfig = process.platform === 'darwin' 
          ? path.join(os.homedir(), '.zshrc') // macOS default
          : path.join(os.homedir(), '.bashrc'); // Linux default
        
        const exportLine = `\nexport DWS_ACCESS_TOKEN="${token}"\n`;
        
        // Only append if not already present
        if (fs.existsSync(shellConfig)) {
          const content = fs.readFileSync(shellConfig, 'utf-8');
          if (!content.includes('DWS_ACCESS_TOKEN')) {
            fs.appendFileSync(shellConfig, exportLine);
            logger.info(`[TokenStorage] Appended DWS_ACCESS_TOKEN to ${shellConfig}`);
          }
        } else {
          fs.writeFileSync(shellConfig, exportLine);
          logger.info(`[TokenStorage] Created ${shellConfig} with DWS_ACCESS_TOKEN`);
        }
      } catch (error) {
        logger.warn('[TokenStorage] Failed to set env var in shell config:', error);
      }
    }
    
    logger.info('[TokenStorage] Set DWS_ACCESS_TOKEN environment variable');

    // Write to file using DWS environment path
    const tokenFilePath = getDwsTokenPath();
    const tokenDir = path.dirname(tokenFilePath);

    // Ensure directory exists
    if (!fs.existsSync(tokenDir)) {
      fs.mkdirSync(tokenDir, { recursive: true });
      logger.info(`[TokenStorage] Created token directory: ${tokenDir}`);
    }

    // Write token to file
    fs.writeFileSync(tokenFilePath, token, { encoding: 'utf-8' });
    logger.info(`[TokenStorage] Token saved to file: ${tokenFilePath}`);

  } catch (error) {
    logger.error('[TokenStorage] Failed to save token:', error);
    throw error;
  }
}

/**
 * Read token from local file
 * @returns The token string or null if not found
 */
export function readTokenFromFile(): string | null {
  try {
    const tokenFilePath = getDwsTokenPath();

    if (!fs.existsSync(tokenFilePath)) {
      return null;
    }

    const token = fs.readFileSync(tokenFilePath, { encoding: 'utf-8' }).trim();
    return token || null;
  } catch (error) {
    logger.error('[TokenStorage] Failed to read token from file:', error);
    return null;
  }
}

/**
 * Get token from environment variable or file
 * Priority: Environment variable > File
 * @returns The token string or null if not found
 */
export function getToken(): string | null {
  // First check environment variable
  const envToken = process.env['DWS_ACCESS_TOKEN'];
  if (envToken) {
    return envToken;
  }

  // Fall back to file
  return readTokenFromFile();
}

/**
 * Clear token from environment and delete file
 */
export async function clearToken(): Promise<void> {
  try {
    // Clear process environment variable
    delete process.env['DWS_ACCESS_TOKEN'];
    
    // Clear system-level environment variable on Windows
    if (process.platform === 'win32') {
      try {
        // Use setx with empty value to clear the user-level environment variable
        execSync('setx DWS_ACCESS_TOKEN ""', { encoding: 'utf-8' });
        logger.info('[TokenStorage] Cleared DWS_ACCESS_TOKEN system environment variable (Windows)');
      } catch (error) {
        logger.warn('[TokenStorage] Failed to clear system env var with setx:', error);
      }
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // Remove the export line from shell config
      try {
        const shellConfig = process.platform === 'darwin' 
          ? path.join(os.homedir(), '.zshrc')
          : path.join(os.homedir(), '.bashrc');
        
        if (fs.existsSync(shellConfig)) {
          let content = fs.readFileSync(shellConfig, 'utf-8');
          // Remove the DWS_ACCESS_TOKEN export line
          content = content.replace(/\nexport DWS_ACCESS_TOKEN="[^"]*"\n/g, '\n');
          fs.writeFileSync(shellConfig, content);
          logger.info(`[TokenStorage] Removed DWS_ACCESS_TOKEN from ${shellConfig}`);
        }
      } catch (error) {
        logger.warn('[TokenStorage] Failed to clear env var from shell config:', error);
      }
    }
    
    logger.info('[TokenStorage] Cleared DWS_ACCESS_TOKEN environment variable');

    // Delete token file
    const tokenFilePath = getDwsTokenPath();

    if (fs.existsSync(tokenFilePath)) {
      fs.unlinkSync(tokenFilePath);
      logger.info(`[TokenStorage] Deleted token file: ${tokenFilePath}`);
    }
  } catch (error) {
    logger.error('[TokenStorage] Failed to clear token:', error);
    throw error;
  }
}
