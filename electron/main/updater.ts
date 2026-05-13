/**
 * Auto-Updater Module
 * Handles automatic application updates using internal API
 *
 * Uses company internal update API for version checking and download.
 */
import { autoUpdater, UpdateInfo, ProgressInfo, UpdateDownloadedEvent } from 'electron-updater';
import { BrowserWindow, app, ipcMain, shell } from 'electron';
import { logger } from '../utils/logger';
import { EventEmitter } from 'events';
import { setQuitting } from './app-state';

// Use native fetch API (available in Node.js 18+ / Electron)
const fetch = globalThis.fetch;

/** Internal update server base URL */
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

  /** Delay (in seconds) before auto-installing a downloaded update. */
  private static readonly AUTO_INSTALL_DELAY_SECONDS = 5;

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
      info: newStatus.info,
      progress: newStatus.progress,
      error: newStatus.error,
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
   * Get current OS type
   */
  private getOS(): string {
    switch (process.platform) {
      case 'darwin':
        return 'mac';
      case 'linux':
        return 'linux';
      case 'win32':
      default:
        return 'windows';
    }
  }

  /**
   * Check for updates using internal API.
   */
  async checkForUpdates(): Promise<UpdateInfo | null> {
    try {
      const currentVersion = app.getVersion();
      const os = this.getOS();
      const url = `${INTERNAL_UPDATE_URL}/aihome/api/installer/check/?current_version=${encodeURIComponent(currentVersion)}&os=${encodeURIComponent(os)}`;
      
      logger.info(`[Updater] Checking for updates: url=${url}, current_version=${currentVersion}, os=${os}`);
      
      const response = await fetch(url);
      
      logger.info(`[Updater] Response status: ${response.status}`);
      
      if (!response.ok) {
        const responseText = await response.text().catch(() => 'No response body');
        logger.error(`[Updater] HTTP error response body: ${responseText}`);
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: CheckUpdateResponse = await response.json();
      logger.info('[Updater] Check update response:', data);

      if (data.need_update && data.latest_version) {
        const updateInfo: UpdateInfo = {
          version: data.latest_version,
          releaseNotes: data.changelog || undefined,
          downloadUrl: data.download_url,
        };
        this.updateStatus({ status: 'available', info: updateInfo });
        return updateInfo;
      } else {
        const updateInfo: UpdateInfo = {
          version: currentVersion,
        };
        this.updateStatus({ status: 'not-available', info: updateInfo });
        return null;
      }
    } catch (error) {
      logger.error('[Updater] Check for updates failed:', error);
      this.updateStatus({ status: 'error', error: (error as Error).message || String(error) });
      throw error;
    }
  }

  /**
   * Download available update using internal API
   */
  async downloadUpdate(): Promise<void> {
    try {
      const os = this.getOS();
      const downloadUrl = `${INTERNAL_UPDATE_URL}/aihome/api/download/?os=${encodeURIComponent(os)}`;
      
      logger.info('[Updater] Downloading update from:', downloadUrl);
      
      // 使用直接下载方式，兼容返回安装包文件的接口
      const response = await fetch(downloadUrl);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      // 获取文件大小用于进度计算
      const contentLength = parseInt(response.headers.get('content-length') || '0');
      
      // 创建更新文件路径（使用应用目录而非临时目录，避免退出时被清理）
      const path = require('path');
      const fs = require('fs').promises;
      const appDir = app.getPath('userData');
      const ext = this.getOS() === 'windows' ? '.exe' : this.getOS() === 'mac' ? '.dmg' : '.tar.gz';
      const fileName = `update_${Date.now()}${ext}`;
      const filePath = path.join(appDir, fileName);
      
      logger.info('[Updater] Saving update file to:', filePath);
      
      // 下载并保存文件
      const fileStream = await fs.open(filePath, 'w');
      const responseStream = response.body;
      
      let downloadedBytes = 0;
      for await (const chunk of responseStream) {
        await fileStream.write(chunk);
        downloadedBytes += chunk.length;
        
        // 发送进度更新
        const progress: ProgressInfo = {
          percent: contentLength > 0 ? (downloadedBytes / contentLength) * 100 : 0,
          transferred: downloadedBytes,
          total: contentLength,
        };
        this.updateStatus({ status: 'downloading', progress });
      }
      
      await fileStream.close();
      
      logger.info('[Updater] Download completed, size:', downloadedBytes);
      
      // 使用 electron-updater 安装本地文件
      this.updateStatus({ status: 'downloaded' });
      
      // 保存下载的文件路径供安装使用
      this.downloadedFilePath = filePath;
      
    } catch (error) {
      logger.error('[Updater] Download update failed:', error);
      this.updateStatus({ status: 'error', error: (error as Error).message || String(error) });
      throw error;
    }
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
    
    // 如果有本地下载的文件，直接执行安装
    if (this.downloadedFilePath) {
      logger.info('[Updater] Installing from local file:', this.downloadedFilePath);
      
      const { spawn } = require('child_process');
      const path = require('path');
      
      // 获取安装程序所在目录作为工作目录
      const installerDir = path.dirname(this.downloadedFilePath);
      
      const installer = spawn(this.downloadedFilePath, ['/S'], { 
        detached: true,
        stdio: 'ignore',
        cwd: installerDir,
        shell: true
      });
      
      // 添加错误处理
      installer.on('error', (err: Error) => {
        logger.error('[Updater] Failed to spawn installer:', err.message);
        // 如果安装程序启动失败，尝试使用 electron-updater
        autoUpdater.quitAndInstall();
      });
      
      installer.on('exit', (code: number) => {
        logger.info('[Updater] Installer process exited with code:', code);
      });
      
      installer.unref();
      
      // 等待安装程序启动后再退出应用，确保主程序文件未被锁定
      // 使用 setTimeout 确保安装程序有足够时间启动
      logger.info('[Updater] Installer spawned, waiting before exit');
      setTimeout(() => {
        logger.info('[Updater] Exiting application for update');
        // 使用 app.exit() 强制退出，确保应用立即关闭
        app.exit(0);
      }, 2000);
    } else {
      logger.info('[Updater] No downloaded file path, using autoUpdater.quitAndInstall()');
      // 使用 electron-updater 的默认安装方式
      autoUpdater.quitAndInstall();
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
        this.quitAndInstall();
      }
    }, 1000);
  }

  cancelAutoInstall(): void {
    this.clearAutoInstallTimer();
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
   * Open the directory containing the downloaded update file
   */
  openDownloadedFileDirectory(): void {
    if (this.downloadedFilePath) {
      const path = require('path');
      const dir = path.dirname(this.downloadedFilePath);
      logger.info('[Updater] Opening download directory:', dir);
      shell.showItemInFolder(this.downloadedFilePath);
    }
  }
}

/**
 * Register IPC handlers for update operations
 */
export function registerUpdateHandlers(
  updater: AppUpdater,
  mainWindow: BrowserWindow
): void {
  updater.setMainWindow(mainWindow);

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
      return { success: true, status: updater.getStatus() };
    } catch (error) {
      return { success: false, error: String(error), status: updater.getStatus() };
    }
  });

  // Download update
  ipcMain.handle('update:download', async () => {
    try {
      await updater.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
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
  ipcMain.handle('update:getDownloadedFilePath', () => {
    return { success: true, filePath: updater.getDownloadedFilePath() };
  });

  // Open the directory containing the downloaded update file
  ipcMain.handle('update:openDownloadDirectory', () => {
    updater.openDownloadedFileDirectory();
    return { success: true };
  });

}

// Export singleton instance
export const appUpdater = new AppUpdater();
