/**
 * Persistent Storage
 * Electron-store wrapper for application settings
 */

import { randomBytes } from 'crypto';
import { app } from 'electron';
import { resolveSupportedLanguage } from '../../shared/language';
import type { SecurityMode } from '../security/types';

// Lazy-load electron-store (ESM module)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let settingsStoreInstance: any = null;

const INTERNAL_MIGRATIONS_KEY = '_internalMigrations';

interface InternalSettingsMigrations {
  telemetryOptOutV202606?: boolean;
}

/** One-time migration: disable legacy PostHog telemetry for existing installs. */
export function applySettingsMigrations(store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
}): void {
  const migrations = (store.get(INTERNAL_MIGRATIONS_KEY) as InternalSettingsMigrations | undefined) ?? {};
  if (migrations.telemetryOptOutV202606) {
    return;
  }

  if (store.get('telemetryEnabled') === true) {
    store.set('telemetryEnabled', false);
  }

  store.set(INTERNAL_MIGRATIONS_KEY, {
    ...migrations,
    telemetryOptOutV202606: true,
  });
}

/**
 * Generate a random token for gateway authentication
 */
function generateToken(): string {
  return `LYClaw-${randomBytes(16).toString('hex')}`;
}

/**
 * Application settings schema
 */
export interface AppSettings {
  // General
  theme: 'light' | 'dark' | 'system';
  language: string;
  startMinimized: boolean;
  launchAtStartup: boolean;
  telemetryEnabled: boolean;
  securityMode: SecurityMode;
  machineId: string;
  hasReportedInstall: boolean;

  // Gateway
  gatewayAutoStart: boolean;
  gatewayPort: number;
  gatewayToken: string;
  proxyEnabled: boolean;
  proxyServer: string;
  proxyHttpServer: string;
  proxyHttpsServer: string;
  proxyAllServer: string;
  proxyBypassRules: string;

  // Update
  updateChannel: 'stable' | 'beta' | 'dev';
  autoCheckUpdate: boolean;
  autoDownloadUpdate: boolean;
  skippedVersions: string[];

  // UI State
  sidebarCollapsed: boolean;
  devModeUnlocked: boolean;

  // Presets
  selectedBundles: string[];
  enabledSkills: string[];
  disabledSkills: string[];
  // DingTalk Login
  dingtalkUser: {
    openId: string;
    unionId: string;
    name: string;
    avatar: string;
    mobile: string;
    email: string;
    orgEmail: string;
    jobNumber: string;
    title: string;
    workPlace: string;
    userId: string;
    nickname: string;
    admin: boolean;
    boss: boolean;
    senior: boolean;
    active: boolean;
    disableStatus: boolean;
    hideMobile: boolean;
    realAuthed: boolean;
    createTime: string;
    hiredDate: number;
    loginId: string;
    managerUserId: string;
    exclusiveAccount: boolean;
    exclusiveAccountType: string;
    exclusiveAccountCorpId: string;
    exclusiveAccountCorpName: string;
    deptIdList: number[];
    roleList: Array<{ group_name: string; id: number; name: string }>;
    leaderInDept: Array<{ dept_id: number; leader: boolean }>;
    departmentIds: string[];
    leaderUserId: string;
    loginAt: string;
  } | null;
  dingtalkUserBindings: Record<string, {
    dingUserId: string;
    unionId: string;
    officialAccountId: string;
    personalAccountIds: string[];
    defaultAccountId: string;
    agentId: string;
    sessionKey: string;
    createdAt: string;
    updatedAt: string;
  }>;

  // Usage reporting (token / skill download / skill invoke).
  // The queue is the exact payload uploaded to backend, no aggregation,
  // so callers can append a record and forget; cleared on successful upload.
  usageReportQueue: {
    tokenConsume: Array<{
      workNo: string;
      model: string;
      consume: number;
      /** "YYYY-MM-DD HH:MM:SS" — backend field is `consumeTime`, not `date`. */
      consumeTime: string;
    }>;
    skillDownload: Array<{
      workNo: string;
      skillId: string;
      count: number;
      /** "YYYY-MM-DD HH:MM:SS" — backend field is `downloadTime`, not `date`. */
      downloadTime: string;
    }>;
    skillInvoke: Array<{
      workNo: string;
      skillId: string;
      count: number;
      /** "YYYY-MM-DD HH:MM:SS" — backend field is `invokeTime`. */
      invokeTime: string;
    }>;
    execution: Array<{
      execution_id: string;
      conversation_id: string;
      turn_index?: number;
      work_no: string;
      entry_source: 'chat' | 'digital_employee' | 'schedule';
      agent_type: 'normal' | 'digital_employee';
      agent_id: string;
      model_id: string;
      status: 'success' | 'failed' | 'cancelled';
      started_at?: string;
      ended_at?: string;
      first_response_ms?: number;
      input_tokens?: number;
      output_tokens?: number;
      cache_read_tokens?: number;
      create_by?: string;
      create_date?: string;
      update_by?: string;
      update_date?: string;
      error_stage?: 'client' | 'gateway' | 'model';
      error_message?: string;
      app_version?: string;
    }>;
  };
  /** Last successful uploads — used by the daily scheduler to detect missed slots. */
  usageReportLastUploadAt: {
    tokenConsume: string | null;
    skillDownload: string | null;
    skillInvoke: string | null;
    execution: string | null;
  };
  /**
   * ISO timestamp watermark for transcript-based token-consume scanning.
   * Only entries with `timestamp > cursor` are queued, so re-runs across
   * restarts never double-count the same assistant turn.
   */
  usageReportTokenScanCursor: string | null;
  /** Last known DingTalk jobNumber for usage-report payloads. */
  usageReportCachedWorkNo: string | null;
}

/**
 * Default settings
 */
function getSystemLocale(): string {
  const preferredLanguages = typeof app.getPreferredSystemLanguages === 'function'
    ? app.getPreferredSystemLanguages()
    : [];
  return preferredLanguages[0]
    || (typeof app.getLocale === 'function' ? app.getLocale() : '')
    || Intl.DateTimeFormat().resolvedOptions().locale
    || 'en';
}

function createDefaultSettings(): AppSettings {
  return {
    // General
    theme: 'system',
    language: resolveSupportedLanguage(getSystemLocale()),
    startMinimized: false,
    launchAtStartup: false,
    telemetryEnabled: false,
    securityMode: 'trusted',
    machineId: '',
    hasReportedInstall: false,

    // Gateway
    gatewayAutoStart: true,
    gatewayPort: 18789,
    gatewayToken: generateToken(),
    proxyEnabled: false,
    proxyServer: '',
    proxyHttpServer: '',
    proxyHttpsServer: '',
    proxyAllServer: '',
    proxyBypassRules: '<local>;localhost;127.0.0.1;::1',

    // Update
    updateChannel: 'stable',
    autoCheckUpdate: true,
    autoDownloadUpdate: false,
    skippedVersions: [],

    // UI State
    sidebarCollapsed: false,
    devModeUnlocked: false,

    // Presets
    selectedBundles: ['productivity', 'developer'],
    enabledSkills: [],
    disabledSkills: [],
    // DingTalk Login
    dingtalkUser: null,
    dingtalkUserBindings: {},

    // Usage reporting
    usageReportQueue: {
      tokenConsume: [],
      skillDownload: [],
      skillInvoke: [],
      execution: [],
    },
    usageReportLastUploadAt: {
      tokenConsume: null,
      skillDownload: null,
      skillInvoke: null,
      execution: null,
    },
    usageReportTokenScanCursor: null,
    usageReportCachedWorkNo: null,
  };
}

/**
 * Get the settings store instance (lazy initialization)
 */
async function getSettingsStore() {
  if (!settingsStoreInstance) {
    const Store = (await import('electron-store')).default;
    settingsStoreInstance = new Store<AppSettings>({
      name: 'settings',
      defaults: createDefaultSettings(),
    });
    applySettingsMigrations(settingsStoreInstance);
  }
  return settingsStoreInstance;
}

/**
 * Get a setting value
 */
export async function getSetting<K extends keyof AppSettings>(key: K): Promise<AppSettings[K]> {
  const store = await getSettingsStore();
  return store.get(key);
}

/**
 * Set a setting value
 */
export async function setSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K]
): Promise<void> {
  const store = await getSettingsStore();
  store.set(key, value);
}

/**
 * Get all settings
 */
export async function getAllSettings(): Promise<AppSettings> {
  const store = await getSettingsStore();
  return store.store;
}

/**
 * Reset settings to defaults
 */
export async function resetSettings(): Promise<void> {
  const store = await getSettingsStore();
  store.clear();
}

/**
 * Export settings to JSON
 */
export async function exportSettings(): Promise<string> {
  const store = await getSettingsStore();
  return JSON.stringify(store.store, null, 2);
}

/**
 * Import settings from JSON
 */
export async function importSettings(json: string): Promise<void> {
  try {
    const settings = JSON.parse(json);
    const store = await getSettingsStore();
    store.set(settings);
  } catch {
    throw new Error('Invalid settings JSON');
  }
}
