/**
 * Auto-Updater Module
 * Handles automatic application updates using internal API
 *
 * Uses company internal update API for version checking and download.
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import { access, open, readdir, stat, unlink } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { logger } from '../utils/logger';
import { buildUpdateInstallerArgs } from '../utils/update-installer-args';
import { launchMacDmgUpdateInstall } from '../utils/mac-update-installer';
import { EventEmitter } from 'events';
import { setQuitting } from './app-state';
import {
  formatUpdateFriendlyError,
  parseCheckUpdateResponseBody,
} from '../utils/update-errors';

// Use native fetch API (available in Node.js 18+ / Electron)
const fetch = globalThis.fetch;

/** Internal update server base URL */
// const INTERNAL_UPDATE_URL = 'http://100.0.4.203';
const INTERNAL_UPDATE_URL = 'http://portal.srv.lstech.com';
/** Internal API response types */
interface CheckUpdateResponse {
  need_update: boolean;
  latest_version: string;
  changelog: string;
  download_url: string;
}

export interface UpdateStatus {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  info?: UpdateInfo;
  progress?: ProgressInfo;
  error?: string;
}

export interface UpdaterEvents {
  'status-changed': (status: UpdateStatus) => void;
  'checking-for-update': () => void;
  'update-available': (info: UpdateInfo) => void;
  'update-not-available': (info: UpdateInfo) => void;
  'download-progress': (progress: ProgressInfo) => void;
  'update-downloaded': (event: UpdateDownloadedEvent) => void;
  'error': (error: Error) => void;
}

export class AppUpdater extends EventEmitter {
  private mainWindow: BrowserWindow | null = null;
  private status: UpdateStatus = { status: 'idle' };
  private autoInstallTimer: NodeJS.Timeout | null = null;
  private autoInstallCountdown = 0;
  private downloadedFilePath: string | null = null;
  private resolvedUpdateOS: string | null = null;
  private prepareForUpdateInstall: (() => Promise<void>) | null = null;
  private downloadAbortController: AbortController | null = null;
  private downloadCancelled = false;
  private activeDownloadPromise: Promise<void> | null = null;

  /** Delay (in seconds) before auto-installing a downloaded update. */
  private static readonly AUTO_INSTALL_DELAY_SECONDS = 5;
  /** Reject downloads smaller than this (empty/error HTML responses). */
  private static readonly MIN_DOWNLOAD_BYTES = 64 * 1024;
  /** Brief pause after spawning NSIS so the detached installer can attach. */
  private static readonly QUIT_AFTER_SPAWN_DELAY_MS = 1500;

  constructor() {
    super();

    // EventEmitter treats an unhandled 'error' event as fatal. Keep a default
    // listener so updater failures surface in logs/UI without terminating main.
    this.on('error', (error: Error) => {
      logger.error('[Updater] AppUpdater emitted error:', error);
    });
    
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    
    autoUpdater.logger = {
      info: (msg: string) => logger.info('[Updater]', msg),
      warn: (msg: string) => logger.warn('[Updater]', msg),
      error: (msg: string) => logger.error('[Updater]', msg),
      debug: (msg: string) => logger.debug('[Updater]', msg),
    };

    const version = app.getVersion();
    logger.info(`[Updater] Version: ${version}, update server: ${INTERNAL_UPDATE_URL}`);

    this.setupListeners();
  }

  /**
   * Set the main window for sending update events
   */
  setMainWindow(window: BrowserWindow): void {
    this.mainWindow = window;
  }

  /**
   * Hook invoked before launching a downloaded installer (e.g. stop Gateway).
   */
  setPrepareForUpdateInstall(hook: (() => Promise<void>) | null): void {
    this.prepareForUpdateInstall = hook;
  }

  /**
   * Get current update status
   */
  getStatus(): UpdateStatus {
    return this.status;
  }

  /**
   * Setup auto-updater event listeners
   */
  private setupListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      this.updateStatus({ status: 'checking' });
      this.emit('checking-for-update');
    });

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'available', info });
      this.emit('update-available', info);
    });

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      this.updateStatus({ status: 'not-available', info });
      this.emit('update-not-available', info);
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.updateStatus({ status: 'downloading', progress });
      this.emit('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.updateStatus({ status: 'downloaded', info: event });
      this.emit('update-downloaded', event);

      if (autoUpdater.autoDownload) {
        this.startAutoInstallCountdown();
      }
    });

    autoUpdater.on('error', (error: Error) => {
      this.updateStatus({ status: 'error', error: error.message });
      this.emit('error', error);
    });
  }

  /**
   * Update status and notify renderer
   */
  private updateStatus(newStatus: Partial<UpdateStatus>): void {
    this.status = {
      status: newStatus.status ?? this.status.status,
      info: 'info' in newStatus ? newStatus.info : this.status.info,
      progress: 'progress' in newStatus ? newStatus.progress : this.status.progress,
      error: 'error' in newStatus ? newStatus.error : this.status.error,
    };
    this.sendToRenderer('update:status-changed', this.status);
  }

  /**
   * Send event to renderer process
   */
  private sendToRenderer(channel: string, data: unknown): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, data);
    }
  }

  /**
   * Resolve the newest downloaded installer in userData.
   * Falls back to scanning update_* files when the in-memory path is missing.
   */
  private async resolveLatestDownloadedPackage(): Promise<string | null> {
    if (this.downloadedFilePath) {
      try {
        await access(this.downloadedFilePath);
        return this.downloadedFilePath;
      } catch {
        logger.warn('[Updater] Remembered download path is missing:', this.downloadedFilePath);
      }
    }

    const appDir = app.getPath('userData');
    const expectedExt = this.getOS() === 'windows'
      ? '.exe'
      : this.getOS() === 'macos'
        ? '.dmg'
        : '.tar.gz';

    let entries: string[];
    try {
      entries = await readdir(appDir);
    } catch (error) {
      logger.warn('[Updater] Failed to scan download directory:', error);
      return null;
    }

    let latestPath: string | null = null;
    let latestMtime = 0;
    for (const entry of entries) {
      if (!/^update_\d+/.test(entry) || !entry.endsWith(expectedExt)) {
        continue;
      }
      const candidatePath = path.join(appDir, entry);
      try {
        const fileStat = await stat(candidatePath);
        if (!fileStat.isFile()) continue;
        if (fileStat.mtimeMs >= latestMtime) {
          latestMtime = fileStat.mtimeMs;
          latestPath = candidatePath;
        }
      } catch {
        continue;
      }
    }

    if (latestPath) {
      this.downloadedFilePath = latestPath;
      logger.info('[Updater] Resolved latest downloaded package:', latestPath);
    }

    return latestPath;
  }

  /**
   * Get current OS type
   */
  private getOS(): string {
    switch (process.platform) {
      case 'darwin':
        return 'macos';
      case 'linux':
        return 'linux';
      case 'win32':
      default:
        return 'windows';
    }
  }

  private getOSCandidates(): string[] {
    switch (process.platform) {
      case 'darwin':
        return ['macos'];
      case 'linux':
        return ['linux'];
      case 'win32':
      default:
        return ['windows', 'win'];
    }
  }

  private buildCheckUrl(currentVersion: string, os: string): string {
    return `${INTERNAL_UPDATE_URL}/aihome/api/installer/check/?current_version=${encodeURIComponent(currentVersion)}&os=${encodeURIComponent(os)}`;
  }

  private getDownloadOSCandidates(): string[] {
    const candidates = this.getOSCandidates();
    return this.resolvedUpdateOS
      ? [this.resolvedUpdateOS, ...candidates.filter((os) => os !== this.resolvedUpdateOS)]
      : candidates;
  }

  /**
   * Check for updates using internal API.
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    this.resolvedUpdateOS = null;
    try {
      const currentVersion = app.getVersion();
      const osCandidates = this.getOSCandidates();
      let lastError: Error | null = null;
      let firstNotAvailableInfo: UpdateInfo | null = null;

      this.updateStatus({
        status: 'checking',
        info: undefined,
        progress: undefined,
        error: undefined,
      });

      logger.info('[Updater] ========== Update check started ==========');
      logger.info(
        `[Updater] Request params: ${JSON.stringify({
          current_version: currentVersion,
          os_candidates: osCandidates,
          base_url: INTERNAL_UPDATE_URL,
        })}`,
      );

      for (const os of osCandidates) {
        const url = this.buildCheckUrl(currentVersion, os);

        logger.info(`[Updater] Request URL: ${url}`);

        try {
          const response = await fetch(url);

          logger.info(`[Updater] Response status (os=${os || '(empty)'}): HTTP ${response.status}`);

          if (!response.ok) {
            const responseText = await response.text().catch(() => 'No response body');
            logger.error(
              `[Updater] Response body (os=${os || '(empty)'}): ${responseText}`,
            );
            lastError = new Error(`HTTP error! status: ${response.status}`);
            continue;
          }

          const responseText = await response.text();
          logger.info(
            `[Updater] Response body (os=${os || '(empty)'}): ${responseText}`,
          );

          const data = parseCheckUpdateResponseBody(responseText) as CheckUpdateResponse;

          if (data.need_update && data.latest_version) {
            if (data.latest_version.trim() === currentVersion) {
              logger.warn('[Updater] need_update=true but latest_version equals current version; treating as no update');
              if (!firstNotAvailableInfo) {
                firstNotAvailableInfo = {
                  version: currentVersion,
                } as unknown as UpdateInfo;
              }
              continue;
            }

            const updateInfo = {
              version: data.latest_version,
              releaseNotes: data.changelog || undefined,
              downloadUrl: data.download_url,
            } as unknown as UpdateInfo;
            this.resolvedUpdateOS = os;
            logger.info(
              `[Updater] Update check result: update available -> ${JSON.stringify({
                success: true,
                os,
                latest_version: data.latest_version,
                download_url: data.download_url,
              })}`,
            );
            this.cancelAutoInstall();
            this.updateStatus({ status: 'available', info: updateInfo, progress: undefined, error: undefined });
            return updateInfo;
          }

          if (!firstNotAvailableInfo) {
            firstNotAvailableInfo = {
              version: data.latest_version || currentVersion,
            } as unknown as UpdateInfo;
          }
        } catch (error) {
          lastError = error as Error;
          logger.error(
            `[Updater] Request failed (os=${os || '(empty)'}): ${(error as Error).message || String(error)}`,
          );
        }
      }

      if (firstNotAvailableInfo) {
        this.resolvedUpdateOS = osCandidates[0] ?? this.getOS();
        logger.info(
          `[Updater] Update check result: already on latest -> ${JSON.stringify({
            success: true,
            latest_version: firstNotAvailableInfo.version,
            resolved_os: this.resolvedUpdateOS,
          })}`,
        );
        this.updateStatus({ status: 'not-available', info: firstNotAvailableInfo });
        return null;
      }

      throw lastError ?? new Error('Check update failed');
    } catch (error) {
      logger.error(
        `[Updater] Update check result: failed -> ${(error as Error).message || String(error)}`,
      );
      logger.error('[Updater] Check for updates failed:', error);
      const friendlyError = formatUpdateFriendlyError((error as Error).message || String(error));
      this.cancelAutoInstall();
      this.updateStatus({
        status: 'error',
        error: friendlyError,
        info: undefined,
        progress: undefined,
      });
      throw error;
    } finally {
      logger.info('[Updater] ========== Update check finished ==========');
    }
  }

  /**
   * Download available update using internal API
   */
  async downloadUpdate(): Promise<void> {
    if (this.status.status !== 'available' || !this.status.info?.version) {
      const friendlyError = formatUpdateFriendlyError('Check update failed');
      this.updateStatus({
        status: 'error',
        error: friendlyError,
        info: undefined,
        progress: undefined,
      });
      throw new Error(friendlyError);
    }

    const task = this.performDownload();
    this.activeDownloadPromise = task;
    try {
      await task;
    } finally {
      if (this.activeDownloadPromise === task) {
        this.activeDownloadPromise = null;
      }
    }
  }

  private async performDownload(): Promise<void> {
    let fileStream: Awaited<ReturnType<typeof open>> | null = null;
    let filePath: string | null = null;

    try {
      this.cancelAutoInstall();
      this.downloadCancelled = false;
      this.downloadAbortController = new AbortController();
      const { signal } = this.downloadAbortController;

      this.updateStatus({
        status: 'downloading',
        info: this.status.info,
        progress: {
          percent: 0,
          transferred: 0,
          total: 0,
          delta: 0,
          bytesPerSecond: 0,
        },
        error: undefined,
      });

      const os = this.getDownloadOSCandidates()[0] ?? this.getOS();
      const downloadUrl = `${INTERNAL_UPDATE_URL}/aihome/api/download/?os=${encodeURIComponent(os)}`;
      
      logger.info(`[Updater] Downloading update from: ${downloadUrl}, os=${os || '(empty)'}`);
      
      const response = await fetch(downloadUrl, { signal });
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const contentLength = parseInt(response.headers.get('content-length') || '0');
      
      const appDir = app.getPath('userData');
      const ext = this.getOS() === 'windows' ? '.exe' : this.getOS() === 'macos' ? '.dmg' : '.tar.gz';
      const fileName = `update_${Date.now()}${ext}`;
      filePath = path.join(appDir, fileName);
      
      logger.info('[Updater] Saving update file to:', filePath);
      
      fileStream = await open(filePath, 'w');
      const responseStream = response.body;
      if (!responseStream) {
        throw new Error('Download response body is empty');
      }
      
      let downloadedBytes = 0;
      for await (const chunk of responseStream) {
        if (this.downloadCancelled) {
          throw new Error('DOWNLOAD_CANCELLED');
        }

        await fileStream.write(chunk);
        downloadedBytes += chunk.length;
        
        const progress: ProgressInfo = {
          percent: contentLength > 0 ? (downloadedBytes / contentLength) * 100 : 0,
          transferred: downloadedBytes,
          total: contentLength,
          delta: chunk.length,
          bytesPerSecond: 0,
        };
        this.updateStatus({ status: 'downloading', info: this.status.info, progress });
      }
      
      await fileStream.close();
      fileStream = null;
      
      logger.info('[Updater] Download completed, size:', downloadedBytes);

      if (downloadedBytes < AppUpdater.MIN_DOWNLOAD_BYTES) {
        throw new Error(
          downloadedBytes === 0
            ? 'Download failed: empty response (check network connection)'
            : `Download failed: file too small (${downloadedBytes} bytes)`,
        );
      }

      this.updateStatus({ status: 'downloaded', info: this.status.info, progress: undefined });

      this.downloadedFilePath = filePath;
      filePath = null;

      this.startAutoInstallCountdown();

    } catch (error) {
      if (fileStream) {
        await fileStream.close().catch(() => {});
      }

      if (this.isDownloadCancelled(error)) {
        if (filePath) {
          await unlink(filePath).catch(() => {});
        }
        logger.info('[Updater] Download cancelled by user');
        this.updateStatus({
          status: 'available',
          info: this.status.info,
          progress: undefined,
          error: undefined,
        });
        return;
      }

      logger.error('[Updater] Download update failed:', error);
      if (filePath) {
        await unlink(filePath).catch(() => {});
      }
      this.cancelAutoInstall();
      const friendlyError = formatUpdateFriendlyError((error as Error).message || String(error));
      this.updateStatus({
        status: 'error',
        error: friendlyError,
        progress: undefined,
      });
      throw error;
    } finally {
      this.downloadAbortController = null;
      this.downloadCancelled = false;
    }
  }

  /** Abort an in-progress update download and revert to available. */
  async cancelDownload(): Promise<void> {
    if (this.status.status !== 'downloading') {
      return;
    }
    logger.info('[Updater] Download cancel requested');
    this.downloadCancelled = true;
    this.downloadAbortController?.abort();
    if (this.activeDownloadPromise) {
      await this.activeDownloadPromise.catch(() => {});
    }
  }

  private isDownloadCancelled(error: unknown): boolean {
    if (this.downloadCancelled) return true;
    if (error instanceof Error) {
      if (error.message === 'DOWNLOAD_CANCELLED') return true;
      if (error.name === 'AbortError') return true;
    }
    return false;
  }

  /**
   * Install update and restart.
   *
   * On macOS, electron-updater delegates to Squirrel.Mac (ShipIt). The
   * native quitAndInstall() spawns ShipIt then internally calls app.quit().
   * However, the tray close handler in index.ts intercepts window close
   * and hides to tray unless isQuitting is true. Squirrel's internal quit
   * sometimes fails to trigger before-quit in time, so we set isQuitting
   * BEFORE calling quitAndInstall(). This lets the native quit flow close
   * the window cleanly while ShipIt runs independently to replace the app.
   */
  quitAndInstall(): void {
    logger.info('[Updater] quitAndInstall called');
    setQuitting();

    void this.runLocalInstallerAndQuit().catch((error) => {
      logger.error('[Updater] runLocalInstallerAndQuit failed:', error);
      this.cancelAutoInstall();
      this.updateStatus({
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async launchWindowsInstaller(installerPath: string): Promise<void> {
    const installerArgs = buildUpdateInstallerArgs(process.platform, { silent: false });
    logger.info('[Updater] Launching Windows installer:', installerPath, installerArgs.join(' '));

    await new Promise<void>((resolve, reject) => {
      const installer = spawn(installerPath, installerArgs, {
        detached: true,
        stdio: 'ignore',
        cwd: path.dirname(installerPath),
        // Show the NSIS window so users can respond to AV prompts during file replacement.
        windowsHide: false,
      });

      installer.once('error', (err: Error) => {
        logger.error('[Updater] Failed to spawn installer:', err.message);
        reject(err);
      });

      installer.once('spawn', () => {
        logger.info('[Updater] Installer process spawned', `pid=${installer.pid ?? 'unknown'}`);
        installer.unref();
        resolve();
      });
    });
  }

  private async runLocalInstallerAndQuit(): Promise<void> {
    const installerPath = await this.resolveLatestDownloadedPackage();
    if (!installerPath) {
      logger.error('[Updater] No downloaded installer found; aborting auto-install');
      this.updateStatus({
        status: 'error',
        error: 'Downloaded installer not found. Please open the folder and install manually.',
      });
      return;
    }

    if (this.prepareForUpdateInstall) {
      try {
        await this.prepareForUpdateInstall();
      } catch (error) {
        logger.warn('[Updater] prepareForUpdateInstall failed (continuing):', error);
      }
    }

    try {
      if (process.platform === 'darwin') {
        logger.info('[Updater] Launching macOS DMG install script:', installerPath);
        await launchMacDmgUpdateInstall(installerPath);
      } else if (process.platform === 'win32') {
        await this.launchWindowsInstaller(installerPath);
      } else {
        logger.info('[Updater] Opening installer for manual install:', installerPath);
        await shell.openPath(installerPath);
      }
    } catch (error) {
      this.updateStatus({
        status: 'error',
        error: `Failed to launch installer: ${error instanceof Error ? error.message : String(error)}`,
      });
      logger.info('[Updater] Opening installer for manual install:', installerPath);
      await shell.openPath(installerPath);
      throw error;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, AppUpdater.QUIT_AFTER_SPAWN_DELAY_MS);
    });

    if (process.platform === 'win32') {
      await this.showPreQuitInstallNotice();
    }

    logger.info('[Updater] Quitting application so the update can complete');
    app.quit();
  }

  /**
   * Pause before quitting so the user can read AV guidance and respond to prompts
   * (e.g. 360 blocking DLL replacement) while the installer window is visible.
   */
  private async showPreQuitInstallNotice(): Promise<void> {
    const locale = app.getLocale().toLowerCase();
    const isZh = locale.startsWith('zh');
    const parent = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null;
    const options = {
      type: 'info' as const,
      title: isZh ? '正在安装更新' : 'Installing Update',
      message: isZh ? '安装程序已启动' : 'Installer started',
      detail: isZh
        ? '如果出现 360 等杀毒软件的安全提示，请选择「允许程序所有操作」。\n\n点击「确定」后应用将退出，请在安装窗口中关注安装进度；若再次被拦截，请再次选择允许。'
        : 'If antivirus software (e.g. 360) prompts you, choose "Allow all" for the installer.\n\nClick OK to quit the app. Watch the installer window — if blocked again, allow the operation.',
      buttons: [isZh ? '确定' : 'OK'],
      noLink: true,
    };

    if (parent) {
      await dialog.showMessageBox(parent, options);
    } else {
      await dialog.showMessageBox(options);
    }
  }

  /**
   * Start a countdown that auto-installs the downloaded update.
   * Sends `update:auto-install-countdown` events to the renderer each second.
   */
  private startAutoInstallCountdown(): void {
    this.clearAutoInstallTimer();
    this.autoInstallCountdown = AppUpdater.AUTO_INSTALL_DELAY_SECONDS;
    this.sendToRenderer('update:auto-install-countdown', { seconds: this.autoInstallCountdown });

    this.autoInstallTimer = setInterval(() => {
      this.autoInstallCountdown--;
      this.sendToRenderer('update:auto-install-countdown', { seconds: this.autoInstallCountdown });

      if (this.autoInstallCountdown <= 0) {
        this.clearAutoInstallTimer();
        this.sendToRenderer('update:auto-install-countdown', { seconds: -1, cancelled: true });
        this.quitAndInstall();
      }
    }, 1000);
  }

  cancelAutoInstall(): void {
    this.clearAutoInstallTimer();
    this.autoInstallCountdown = 0;
    this.sendToRenderer('update:auto-install-countdown', { seconds: -1, cancelled: true });
  }

  private clearAutoInstallTimer(): void {
    if (this.autoInstallTimer) {
      clearInterval(this.autoInstallTimer);
      this.autoInstallTimer = null;
    }
  }

  /**
   * Set update channel (stable, beta, dev)
   */
  setChannel(channel: 'stable' | 'beta' | 'dev'): void {
    autoUpdater.channel = channel;
  }

  /**
   * Set auto-download preference
   */
  setAutoDownload(enable: boolean): void {
    autoUpdater.autoDownload = enable;
  }

  /**
   * Get current version
   */
  getCurrentVersion(): string {
    return app.getVersion();
  }

  /**
   * Get the path of the downloaded update file
   */
  getDownloadedFilePath(): string | null {
    return this.downloadedFilePath;
  }

  /**
   * Resolve and return the newest downloaded installer path.
   */
  async resolveDownloadedFilePath(): Promise<string | null> {
    return this.resolveLatestDownloadedPackage();
  }

  /**
   * Open the directory containing the downloaded update file
   */
  openDownloadedFileDirectory(): void {
    void this.resolveLatestDownloadedPackage().then((filePath) => {
      if (!filePath) return;
      logger.info('[Updater] Opening download directory:', path.dirname(filePath));
      shell.showItemInFolder(filePath);
    });
  }
}

/**
 * Register IPC handlers for update operations
 */
export function registerUpdateHandlers(
  updater: AppUpdater,
  mainWindow: BrowserWindow,
  options?: {
    prepareForUpdateInstall?: () => Promise<void>;
  },
): void {
  updater.setMainWindow(mainWindow);
  if (options?.prepareForUpdateInstall) {
    updater.setPrepareForUpdateInstall(options.prepareForUpdateInstall);
  }

  // Get current update status
  ipcMain.handle('update:status', () => {
    return updater.getStatus();
  });

  // Get current version
  ipcMain.handle('update:version', () => {
    return updater.getCurrentVersion();
  });

  // Check for updates – always return final status so the renderer
  // never gets stuck in 'checking' waiting for a push event.
  ipcMain.handle('update:check', async () => {
    try {
      await updater.checkForUpdates();
      await logger.flushLogs();
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      await logger.flushLogs();
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Download update
  ipcMain.handle('update:download', async () => {
    try {
      await updater.downloadUpdate();
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Cancel in-progress download
  ipcMain.handle('update:cancelDownload', async () => {
    await updater.cancelDownload();
    return { success: true, status: updater.getStatus() };
  });

  // Install update and restart
  ipcMain.handle('update:install', () => {
    updater.quitAndInstall();
    return { success: true };
  });

  // Set update channel
  ipcMain.handle('update:setChannel', (_, channel: 'stable' | 'beta' | 'dev') => {
    updater.setChannel(channel);
    return { success: true };
  });

  // Set auto-download preference
  ipcMain.handle('update:setAutoDownload', (_, enable: boolean) => {
    updater.setAutoDownload(enable);
    return { success: true };
  });

  // Cancel pending auto-install countdown
  ipcMain.handle('update:cancelAutoInstall', () => {
    updater.cancelAutoInstall();
    return { success: true };
  });

  // Get downloaded file path
  ipcMain.handle('update:getDownloadedFilePath', async () => {
    const filePath = await updater.resolveDownloadedFilePath();
    return { success: true, filePath };
  });

  // Open the directory containing the downloaded update file
  ipcMain.handle('update:openDownloadDirectory', () => {
    updater.openDownloadedFileDirectory();
    return { success: true };
  });

}

// Export singleton instance
export const appUpdater = new AppUpdater();
