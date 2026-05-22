/**
 * DWS CLI Installer
 * 
 * Extracts and installs the DingTalk Workspace CLI (dws) from bundled resources.
 * The CLI binaries are pre-downloaded during build time and packaged with the app.
 * 
 * This ensures:
 * - No runtime download needed (fast startup)
 * - Works offline
 * - No network dependency
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { app } from 'electron';
import { logger } from './logger';
import { getDwsDir } from './dws-env-setup';

/**
 * Get the platform-specific directory name for bundled resources
 */
function getPlatformDirName(platform: string): string {
  // Support both 'win' and 'win32' directory names
  if (platform === 'win32') {
    return 'win';
  }
  if (platform === 'darwin') {
    return 'darwin';
  }
  if (platform === 'linux') {
    return 'linux';
  }
  return platform;
}

/**
 * Get the DWS CLI installation target path
 * Always install to the user's DWS home. Packaged resources may be read-only
 * depending on the install location, so they are only used as the archive source.
 */
function getDwsTargetDir(): string {
  return getDwsDir();
}

/**
 * Get the bundled DWS CLI archive path from app resources
 */
function getBundledDwsArchive(): string | null {
  const platform = process.platform;
  const arch = process.arch;

  let assetName: string;
  if (platform === 'darwin') {
    assetName = arch === 'arm64' ? 'dws-darwin-arm64.tar.gz' : 'dws-darwin-amd64.tar.gz';
  } else if (platform === 'linux') {
    assetName = arch === 'arm64' ? 'dws-linux-arm64.tar.gz' : 'dws-linux-amd64.tar.gz';
  } else if (platform === 'win32') {
    assetName = arch === 'arm64' ? 'dws-windows-arm64.zip' : 'dws-windows-amd64.zip';
  } else {
    return null;
  }

  const platformDir = getPlatformDirName(platform);
  logger.info(`[DwsCli] Looking for ${assetName}`);
  logger.info(`[DwsCli] App isPackaged: ${app.isPackaged}`);

  const searchPaths = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'dws', platformDir, assetName),
        path.join(process.resourcesPath, 'dws', platform, assetName),
        path.join(process.resourcesPath, 'bin', platformDir, assetName),
        path.join(process.resourcesPath, 'bin', assetName),
        path.join(process.resourcesPath, 'resources', 'bin', platformDir, assetName),
      ]
    : [
        path.join(process.cwd(), 'resources', 'bin', platformDir, assetName),
        path.join(process.cwd(), 'resources', 'bin', platform, assetName),
      ];

  for (const searchPath of searchPaths) {
    logger.info(`[DwsCli] Checking archive path: ${searchPath}`);
    if (fs.existsSync(searchPath)) {
      logger.info('[DwsCli] Found DWS CLI archive');
      return searchPath;
    }
  }

  logger.warn(`[DwsCli] Archive not found. Checked: ${searchPaths.join(', ')}`);
  return null;
}

/**
 * Add DWS CLI directory to system PATH environment variable
 */
function getPathDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':';
}

function normalizePathEntry(entry: string): string {
  const trimmed = entry.trim().replace(/^"|"$/g, '');
  const withoutTrailingSlash = trimmed.replace(/[\\/]+$/g, '');
  return process.platform === 'win32' ? withoutTrailingSlash.toLowerCase() : withoutTrailingSlash;
}

function pathIncludesEntry(pathValue: string, entry: string): boolean {
  const normalizedEntry = normalizePathEntry(entry);
  return pathValue
    .split(getPathDelimiter())
    .map(normalizePathEntry)
    .some((item) => item === normalizedEntry);
}

function ensureCurrentProcessPath(entry: string): void {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path')
    ?? (process.platform === 'win32' ? 'Path' : 'PATH');
  const currentPath = process.env[pathKey] || '';

  if (pathIncludesEntry(currentPath, entry)) {
    return;
  }

  const nextPath = currentPath ? `${entry}${getPathDelimiter()}${currentPath}` : entry;
  process.env[pathKey] = nextPath;

  if (process.platform === 'win32') {
    process.env.Path = nextPath;
    process.env.PATH = nextPath;
  }
}

function psSingleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function addToPath(): void {
  const dwsDir = getDwsDir();
  
  logger.info(`[DwsCli] === addToPath() called ===`);
  logger.info(`[DwsCli] Target directory: ${dwsDir}`);
  logger.info(`[DwsCli] Current platform: ${process.platform}`);

  ensureCurrentProcessPath(dwsDir);
  
  try {
    if (process.platform === 'win32') {
      // Windows: Add to User PATH using PowerShell
      // Check if already in current process PATH
      const currentPath = process.env.Path || process.env.PATH || '';
      logger.info(`[DwsCli] Current PATH length: ${currentPath.length}`);

      logger.info(`[DwsCli] Adding ${dwsDir} to User PATH...`);
      
      // Use PowerShell to modify the User environment variable. The current
      // process PATH is patched above so newly spawned Gateway processes work
      // immediately, without waiting for a Windows environment broadcast.
      const psScript = `
        $ErrorActionPreference = 'Stop'
        $target = ${psSingleQuoted(dwsDir)}
        $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
        if ($null -eq $userPath) { $userPath = '' }
        $targetNorm = [System.IO.Path]::GetFullPath($target).TrimEnd('\\').ToLowerInvariant()
        $exists = $false
        foreach ($part in ($userPath -split ';')) {
          $candidate = $part.Trim().Trim('"')
          if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
          try {
            $candidateNorm = [System.IO.Path]::GetFullPath($candidate).TrimEnd('\\').ToLowerInvariant()
            if ($candidateNorm -eq $targetNorm) {
              $exists = $true
              break
            }
          } catch {
            if ($candidate.ToLowerInvariant() -eq $target.ToLowerInvariant()) {
              $exists = $true
              break
            }
          }
        }
        Write-Host "Current User PATH length: $($userPath.Length)"
        if (-not $exists) {
          if ([string]::IsNullOrWhiteSpace($userPath)) {
            $newPath = $target
          } else {
            $newPath = "$userPath;$target"
          }
          [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
          Write-Host 'User PATH updated successfully'
          Write-Host "Added: $target"
        } else {
          Write-Host 'User PATH already contains DWS directory'
        }
      `.trim();
      
      logger.info(`[DwsCli] PowerShell script:\n${psScript}`);

      const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');
      const result = execFileSync('powershell', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodedScript,
      ], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      logger.info(`[DwsCli]  PowerShell output: ${result.trim()}`);
      logger.info('[DwsCli]  Ensured DWS directory is in PATH');
      
    } else if (process.platform === 'darwin' || process.platform === 'linux') {
      // macOS/Linux: Add to shell config
      const homeDir = process.env.HOME || '';
      const shellConfigs = [
        path.join(homeDir, '.zshrc'),
        path.join(homeDir, '.bashrc'),
        path.join(homeDir, '.bash_profile'),
        path.join(homeDir, '.profile'),
      ];
      
      const exportLine = `\n# DWS CLI\nexport PATH="$HOME/.dws:$PATH"\n`;
      
      let added = false;
      for (const configFile of shellConfigs) {
        if (fs.existsSync(configFile)) {
          const content = fs.readFileSync(configFile, 'utf-8');
          if (!content.includes('$HOME/.dws') && !content.includes(dwsDir)) {
            logger.info(`[DwsCli] Adding to ${configFile}...`);
            fs.appendFileSync(configFile, exportLine);
            logger.info(`[DwsCli]  Added to ${path.basename(configFile)}`);
            added = true;
          }
        }
      }
      
      // If no config file found, create .profile
      if (!added) {
        const profilePath = path.join(homeDir, '.profile');
        if (!fs.existsSync(profilePath)) {
          logger.info(`[DwsCli] Creating ${profilePath}...`);
          fs.writeFileSync(profilePath, exportLine);
          logger.info(`[DwsCli]  Created .profile`);
        }
      }
    }
    
    // Also add to Git Bash config if running on Windows
    if (process.platform === 'win32') {
      const homeDir = process.env.USERPROFILE || process.env.HOME || '';
      const bashrcPath = path.join(homeDir, '.bashrc');
      const bashProfilePath = path.join(homeDir, '.bash_profile');
      
      const exportLine = `\n# DWS CLI\nexport PATH="$HOME/.dws:$PATH"\n`;
      
      for (const configFile of [bashrcPath, bashProfilePath]) {
        try {
          if (fs.existsSync(configFile)) {
            const content = fs.readFileSync(configFile, 'utf-8');
            if (!content.includes('$HOME/.dws') && !content.includes(dwsDir)) {
              logger.info(`[DwsCli] Adding to Git Bash config: ${configFile}`);
              fs.appendFileSync(configFile, exportLine);
              logger.info(`[DwsCli]  Added to ${path.basename(configFile)}`);
            }
          } else {
            // Create .bashrc if it doesn't exist
            logger.info(`[DwsCli] Creating Git Bash config: ${configFile}`);
            fs.writeFileSync(configFile, exportLine);
            logger.info(`[DwsCli]  Created ${path.basename(configFile)}`);
          }
        } catch (error) {
          logger.warn(`[DwsCli] Failed to update ${configFile}:`, error);
        }
      }
    }
  } catch (error) {
    // Don't fail installation if PATH update fails
    logger.warn('[DwsCli] Failed to add to PATH (non-critical):', error);
  }
}

/**
 * Extract tar.gz file
 */
function extractTarGz(tarPath: string, destDir: string): void {
  try {
    execFileSync('tar', ['-xzf', tarPath, '-C', destDir], { stdio: 'pipe' });
  } catch (error) {
    logger.error('[DwsCli] Failed to extract tar.gz:', error);
    throw new Error('Failed to extract DWS CLI archive', { cause: error });
  }
}

/**
 * Extract zip file (Windows)
 */
function extractZip(zipPath: string, destDir: string): void {
  try {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      $zipPath = ${psSingleQuoted(zipPath)}
      $destDir = ${psSingleQuoted(destDir)}
      if (-not (Test-Path -LiteralPath $zipPath -PathType Leaf)) {
        throw "Archive not found: $zipPath"
      }
      if (-not (Test-Path -LiteralPath $destDir -PathType Container)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
      }
      Expand-Archive -LiteralPath $zipPath -DestinationPath $destDir -Force
    `.trim();
    const encodedScript = Buffer.from(psScript, 'utf16le').toString('base64');
    execFileSync('powershell', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedScript,
    ], { stdio: 'pipe' });
  } catch (error) {
    logger.error('[DwsCli] Failed to extract zip:', error);
    throw new Error('Failed to extract DWS CLI archive', { cause: error });
  }
}

/**
 * Find binary file in directory tree
 */
function findBinaryInDir(dir: string, binaryName: string): string | null {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const found = findBinaryInDir(fullPath, binaryName);
        if (found) return found;
      } else if (entry.name === binaryName) {
        return fullPath;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * Install DWS CLI from bundled resources
 */
export async function installDwsCliFromBundle(): Promise<{ success: boolean; error?: string }> {
  try {
    logger.info('[DwsCli] Installing DWS CLI from bundled resources...');

    // 1. Find the bundled archive
    const archivePath = getBundledDwsArchive();
    if (!archivePath) {
      const errorMsg = 'DWS CLI archive not found in bundled resources. Run: pnpm dws:download';
      logger.error(`[DwsCli]  ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }

    logger.info(`[DwsCli] Found bundled archive: ${archivePath}`);
    logger.info(`[DwsCli] Archive size: ${fs.statSync(archivePath).size} bytes`);

    // Use different target based on mode
    const targetDir = getDwsTargetDir();
    const binaryName = process.platform === 'win32' ? 'dws.exe' : 'dws';
    logger.info(`[DwsCli] Target directory: ${targetDir}`);
    logger.info(`[DwsCli] Target binary: ${binaryName}`);
    
    // Create target directory if it doesn't exist
    if (!fs.existsSync(targetDir)) {
      logger.info(`[DwsCli] Creating target directory...`);
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // 2. Create temp extraction directory
    const tempExtractDir = path.join(targetDir, '.dws-cli-temp');
    if (fs.existsSync(tempExtractDir)) {
      logger.info(`[DwsCli] Cleaning up existing temp dir...`);
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempExtractDir, { recursive: true });
    logger.info(`[DwsCli] Temp dir created: ${tempExtractDir}`);

    // 3. Extract the archive
    logger.info('[DwsCli] Extracting DWS CLI...');
    if (archivePath.endsWith('.tar.gz')) {
      logger.info('[DwsCli] Extracting tar.gz...');
      extractTarGz(archivePath, tempExtractDir);
    } else if (archivePath.endsWith('.zip')) {
      logger.info('[DwsCli] Extracting zip...');
      extractZip(archivePath, tempExtractDir);
    } else {
      throw new Error(`Unsupported archive format: ${archivePath}`);
    }

    // List extracted files for debugging
    logger.info('[DwsCli] Listing extracted files...');
    try {
      const files = fs.readdirSync(tempExtractDir, { recursive: true });
      logger.info(`[DwsCli] Extracted ${files.length} items`);
    } catch {
      // ignore
    }

    // 4. Find the binary
    logger.info(`[DwsCli] Searching for ${binaryName}...`);
    const extractedBinary = findBinaryInDir(tempExtractDir, binaryName);
    if (!extractedBinary) {
      logger.error(`[DwsCli]  Binary ${binaryName} not found in archive!`);
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
      return { success: false, error: `Binary ${binaryName} not found in extracted archive` };
    }
    logger.info(`[DwsCli] Found binary at: ${extractedBinary}`);

    // 5. Install the binary
    const targetPath = path.join(targetDir, binaryName);
    if (fs.existsSync(targetPath)) {
      logger.info(`[DwsCli] Removing old binary...`);
      fs.unlinkSync(targetPath);
    }

    logger.info(`[DwsCli] Copying binary to: ${targetPath}`);
    fs.copyFileSync(extractedBinary, targetPath);
    if (!fs.existsSync(targetPath)) {
      throw new Error(`DWS CLI binary copy failed: ${targetPath}`);
    }

    // Make executable on Unix-like systems
    if (process.platform !== 'win32') {
      logger.info('[DwsCli] Setting executable permission...');
      fs.chmodSync(targetPath, 0o755);
    }

    // 6. Cleanup
    logger.info('[DwsCli] Cleaning up temp directory...');
    fs.rmSync(tempExtractDir, { recursive: true, force: true });

    // 7. Add to PATH so child processes and terminals can resolve dws.
    logger.info('[DwsCli] Adding to PATH...');
    addToPath();

    logger.info('[DwsCli] DWS CLI installed successfully');
    logger.info(`[DwsCli] Binary location: ${targetPath}`);
    logger.info("[DwsCli] Restart your terminal to use 'dws' command");
    return { success: true };

  } catch (error) {
    logger.error('[DwsCli]  Failed to install DWS CLI from bundle:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Check if DWS CLI needs installation
 */
function needsInstallation(): boolean {
  const dwsDir = getDwsDir();
  const binaryName = process.platform === 'win32' ? 'dws.exe' : 'dws';
  const targetPath = path.join(dwsDir, binaryName);

  return !fs.existsSync(targetPath);
}

/**
 * Ensure DWS CLI is installed from bundled resources
 */
export async function ensureDwsCliInstalled(): Promise<{ success: boolean; error?: string }> {
  try {
    // Skip in E2E mode
    if (process.env.CLAWX_E2E === '1') {
      return { success: true };
    }

    // If already installed, just ensure PATH is set
    if (!needsInstallation()) {
      logger.info('[DwsCli] DWS CLI is already installed');
      logger.info('[DwsCli] Ensuring PATH is configured...');
      addToPath();
      return { success: true };
    }

    // In packaged app, install from bundled resources
    if (app.isPackaged) {
      logger.info('[DwsCli] Packaged app mode - installing from bundle');
      const result = await installDwsCliFromBundle();
      return result;
    } else {
      // In development mode, try to install from resources
      logger.info('[DwsCli] Development mode - attempting to install from resources');
      const result = await installDwsCliFromBundle();
      if (!result.success) {
        logger.warn('[DwsCli]  Run "pnpm dws:download" to download CLI binaries');
      }
      return result;
    }
  } catch (error) {
    logger.error('[DwsCli]  DWS CLI installation exception:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
