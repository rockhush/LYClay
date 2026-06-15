/**
 * Update State Store
 * Manages application update state
 */
import { create } from 'zustand';
import { useSettingsStore } from './settings';
import { invokeIpc } from '@/lib/api-client';
import { formatUpdateFriendlyError } from '@/lib/update-errors';
import { subscribeHostEvent } from '@/lib/host-events';

export interface UpdateInfo {
  version: string;
  releaseDate?: string;
  releaseNotes?: string | null;
}

export interface ProgressInfo {
  total: number;
  delta: number;
  transferred: number;
  percent: number;
  bytesPerSecond: number;
}

export type UpdateStatus = 
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export function shouldShowUpdateAvailableBadge(status: UpdateStatus): boolean {
  return status === 'available' || status === 'downloaded';
}

interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  updateInfo: UpdateInfo | null;
  progress: ProgressInfo | null;
  error: string | null;
  isInitialized: boolean;
  /** Seconds remaining before auto-install, or null if inactive. */
  autoInstallCountdown: number | null;
  /** Path to the downloaded update file */
  downloadedFilePath: string | null;

  // Actions
  init: () => Promise<void>;
  checkForUpdates: () => Promise<void>;
  checkForUpdatesAfterGatewayReady: () => Promise<void>;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => void;
  cancelAutoInstall: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  setChannel: (channel: 'stable' | 'beta' | 'dev') => Promise<void>;
  setAutoDownload: (enable: boolean) => Promise<void>;
  clearError: () => void;
  getDownloadedFilePath: () => Promise<string | null>;
  openDownloadDirectory: () => Promise<void>;
}

let gatewayStartupUpdateCheckDone = false;

export const useUpdateStore = create<UpdateState>((set, get) => ({
  status: 'idle',
  currentVersion: '0.0.0',
  updateInfo: null,
  progress: null,
  error: null,
  isInitialized: false,
  autoInstallCountdown: null,
  downloadedFilePath: null,

  init: async () => {
    if (get().isInitialized) return;

    // Get current version
    try {
      const version = await invokeIpc<string>('update:version');
      set({ currentVersion: version as string });
    } catch (error) {
      console.error('Failed to get version:', error);
    }

    // Get current status
    try {
      const status = await invokeIpc<{
        status: UpdateStatus;
        info?: UpdateInfo;
        progress?: ProgressInfo;
        error?: string;
      }>('update:status');
      set({
        status: status.status,
        updateInfo: status.info || null,
        progress: status.progress || null,
        error: status.error || null,
      });
    } catch (error) {
      console.error('Failed to get update status:', error);
    }

    // Listen for update events
    // Single source of truth: listen only to update:status-changed
    // (sent by AppUpdater.updateStatus() in the main process)
    subscribeHostEvent('update:status-changed', (data) => {
      const payload = data as {
        status: UpdateStatus;
        info?: UpdateInfo;
        progress?: ProgressInfo;
        error?: string;
      };
      set((state) => ({
        status: payload.status ?? state.status,
        updateInfo: payload.status === 'error'
          ? null
          : ('info' in payload ? (payload.info ?? null) : state.updateInfo),
        progress: 'progress' in payload ? (payload.progress ?? null) : state.progress,
        error: 'error' in payload
          ? (payload.error ? formatUpdateFriendlyError(payload.error) : null)
          : state.error,
        autoInstallCountdown: payload.status === 'error' ? null : state.autoInstallCountdown,
      }));
    });

    subscribeHostEvent('update:auto-install-countdown', (data) => {
      const { seconds, cancelled } = data as { seconds: number; cancelled?: boolean };
      set({ autoInstallCountdown: cancelled || seconds < 0 ? null : seconds });
    });

    set({ isInitialized: true });

    // Apply persisted settings from the settings store
    const { autoCheckUpdate, autoDownloadUpdate } = useSettingsStore.getState();

    // Sync auto-download preference to the main process
    if (autoDownloadUpdate) {
      invokeIpc('update:setAutoDownload', true).catch(() => {});
    }

    // Auto-check for updates on startup (respects user toggle)
    if (autoCheckUpdate) {
      setTimeout(() => {
        get().checkForUpdates().catch(() => {});
      }, 10000);
    }
  },

  checkForUpdates: async () => {
    const active = get().status;
    if (active === 'downloading' || active === 'downloaded') {
      return;
    }

    set({ status: 'checking', error: null, updateInfo: null, progress: null });
    
    try {
      const result = await Promise.race([
        invokeIpc('update:check'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Update check timed out')), 30000))
      ]) as {
        success: boolean;
        error?: string;
        status?: {
          status: UpdateStatus;
          info?: UpdateInfo;
          progress?: ProgressInfo;
          error?: string;
        };
      };
      
      if (result.status) {
        set({
          status: result.status.status,
          updateInfo: result.status.status === 'error' ? null : (result.status.info || null),
          progress: result.status.progress || null,
          error: result.status.error ? formatUpdateFriendlyError(result.status.error) : null,
        });
      } else if (!result.success) {
        const errorMsg = result.error || 'Failed to check for updates';
        set({ status: 'error', updateInfo: null, error: formatUpdateFriendlyError(errorMsg) });
      }
    } catch (error) {
      const errorMsg = String(error);
      set({ status: 'error', updateInfo: null, error: formatUpdateFriendlyError(errorMsg) });
    } finally {
      const currentStatus = get().status;
      if (currentStatus === 'checking') {
        set({
          status: 'error',
          updateInfo: null,
          error: formatUpdateFriendlyError('Update check completed without a result'),
        });
      }
    }
  },

  checkForUpdatesAfterGatewayReady: async () => {
    if (gatewayStartupUpdateCheckDone) return;
    gatewayStartupUpdateCheckDone = true;
    if (!get().isInitialized) {
      await get().init();
    }
    // Startup skill reinstall disabled — keep fetchSkills via ensureGatewayReadySkillsRefetch().
    // void useSkillsStore.getState().autoUpdateInstalledSkillsOnStartup().catch((error) => {
    //   console.warn('[Update Store] Startup skill refresh failed (non-fatal):', error);
    // });
    await get().checkForUpdates();
  },

  downloadUpdate: async () => {
    const { status, updateInfo } = get();
    if (status !== 'available' || !updateInfo?.version) {
      set({
        status: 'error',
        updateInfo: null,
        error: formatUpdateFriendlyError('Check update failed'),
        autoInstallCountdown: null,
      });
      return;
    }

    await get().cancelAutoInstall();

    set({
      status: 'downloading',
      error: null,
      progress: {
        percent: 0,
        transferred: 0,
        total: 0,
        delta: 0,
        bytesPerSecond: 0,
      },
      autoInstallCountdown: null,
    });

    try {
      const result = await invokeIpc<{
        success: boolean;
        error?: string;
        status?: {
          status: UpdateStatus;
          info?: UpdateInfo;
          progress?: ProgressInfo;
          error?: string;
        };
      }>('update:download');

      if (result.status) {
        set({
          status: result.status.status,
          updateInfo: result.status.info ?? get().updateInfo,
          progress: result.status.progress ?? null,
          error: result.status.error ?? null,
          autoInstallCountdown: null,
        });
      }

      if (!result.success) {
        set({
          status: 'error',
          error: formatUpdateFriendlyError(result.error || 'Failed to download update'),
          autoInstallCountdown: null,
        });
      }
    } catch (error) {
      set({
        status: 'error',
        error: formatUpdateFriendlyError(String(error)),
        autoInstallCountdown: null,
      });
    }
  },

  installUpdate: () => {
    void invokeIpc('update:install');
  },

  cancelAutoInstall: async () => {
    try {
      await invokeIpc('update:cancelAutoInstall');
      set({ autoInstallCountdown: null });
    } catch (error) {
      console.error('Failed to cancel auto-install:', error);
    }
  },

  cancelDownload: async () => {
    try {
      const result = await invokeIpc<{
        success: boolean;
        status?: {
          status: UpdateStatus;
          info?: UpdateInfo;
          progress?: ProgressInfo;
          error?: string;
        };
      }>('update:cancelDownload');
      if (result.status) {
        set({
          status: result.status.status,
          updateInfo: result.status.info ?? get().updateInfo,
          progress: result.status.progress ?? null,
          error: result.status.error ?? null,
          autoInstallCountdown: null,
        });
      }
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  },

  getDownloadedFilePath: async () => {
    try {
      const result = await invokeIpc<{ success: boolean; filePath: string | null }>('update:getDownloadedFilePath');
      if (result.success) {
        set({ downloadedFilePath: result.filePath });
        return result.filePath;
      }
      return null;
    } catch (error) {
      console.error('Failed to get downloaded file path:', error);
      return null;
    }
  },

  openDownloadDirectory: async () => {
    try {
      await invokeIpc('update:openDownloadDirectory');
    } catch (error) {
      console.error('Failed to open download directory:', error);
    }
  },

  setChannel: async (channel) => {
    try {
      await invokeIpc('update:setChannel', channel);
    } catch (error) {
      console.error('Failed to set update channel:', error);
    }
  },

  setAutoDownload: async (enable) => {
    try {
      await invokeIpc('update:setAutoDownload', enable);
    } catch (error) {
      console.error('Failed to set auto-download:', error);
    }
  },

  clearError: () => set({ error: null, status: 'idle' }),
}));
