import { app } from 'electron';
import path from 'path';
import { existsSync, readFileSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

function fsPath(filePath: string): string {
  if (process.platform !== 'win32') return filePath;
  if (!filePath) return filePath;
  if (filePath.startsWith('\\\\?\\')) return filePath;
  const windowsPath = filePath.replace(/\//g, '\\');
  if (!path.win32.isAbsolute(windowsPath)) return windowsPath;
  if (windowsPath.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${windowsPath.slice(2)}`;
  }
  return `\\\\?\\${windowsPath}`;
}
import { getAllSettings } from '../utils/store';
import { getApiKey, getDefaultProvider, getProvider } from '../utils/secure-storage';
import { getProviderEnvVar, getKeyableProviderTypes } from '../utils/provider-registry';
import { getOpenClawDir, getOpenClawEntryPath, isOpenClawPresent } from '../utils/paths';
import { getDwsDir } from '../utils/dws-env-setup';
import { getUvMirrorEnv } from '../utils/uv-env';
import { getManagedPythonEnv } from '../utils/uv-setup';
import { cleanupDanglingWeChatPluginState, listConfiguredChannelsFromConfig, listConfiguredChannelAccountsFromConfig, readOpenClawConfig } from '../utils/channel-config';
import { sanitizeOpenClawConfig, batchSyncConfigFields, ensureAgentModelsJsonValid } from '../utils/openclaw-auth';
import { buildProxyEnv, resolveProxySettings } from '../utils/proxy';
import { syncProxyConfigToOpenClaw } from '../utils/openclaw-proxy';
import { logger } from '../utils/logger';
import { prependPathEntry } from '../utils/env-path';
import {
  buildBundledNpmEnv,
  ensureBundledNodeReady,
  getBundledBinDir,
  hasBundledNpmRuntime,
  hasNpmCliRuntime,
} from '../utils/bundled-node';
import { copyPluginFromNodeModules, fixupPluginManifest, cpSyncSafe } from '../utils/plugin-install';
import { assignChannelAccountToAgent, getChannelAccountBindingOwner } from '../utils/agent-config';
import { ensureDingTalkDedicatedAgent, DINGTALK_DEDICATED_AGENT_ID } from '../utils/dingtalk-auto-provision';
import { stripSystemdSupervisorEnv } from './config-sync-env';
import { getCommandPolicyPreflightToken } from '../api/auth-token';
import { getPort } from '../utils/config';
import { inspectOpenClawDigitalEmployeeIsolation } from '../utils/openclaw-digital-employee-isolation';


export interface GatewayLaunchContext {
  appSettings: Awaited<ReturnType<typeof getAllSettings>>;
  openclawDir: string;
  entryScript: string;
  gatewayArgs: string[];
  forkEnv: Record<string, string | undefined>;
  mode: 'dev' | 'packaged';
  binPathExists: boolean;
  npmRuntimeReady: boolean;
  loadedProviderKeyCount: number;
  proxySummary: string;
  channelStartupSummary: string;
}

// ── Auto-upgrade bundled plugins on startup ──────────────────────

const CHANNEL_PLUGIN_MAP: Record<string, { dirName: string; npmName: string }> = {
  dingtalk: { dirName: 'dingtalk', npmName: '@soimy/dingtalk' },
  wecom: { dirName: 'wecom-openclaw-plugin', npmName: '@wecom/wecom-openclaw-plugin' },
  feishu: { dirName: 'feishu-openclaw-plugin', npmName: '@larksuite/openclaw-lark' },

  'openclaw-weixin': { dirName: 'openclaw-weixin', npmName: '@tencent-weixin/openclaw-weixin' },
};

/**
 * OpenClaw 3.22+ ships Discord, Telegram, and other channels as built-in
 * extensions.  If a previous LYClaw version copied one of these into
 * ~/.openclaw/extensions/, the broken copy overrides the working built-in
 * plugin and must be removed.
 */
const BUILTIN_CHANNEL_EXTENSIONS = ['discord', 'telegram', 'qqbot'];
const LYCLAW_COMMAND_POLICY_PLUGIN_ID = 'lyclaw-command-policy';

function writeTextFileIfChanged(filePath: string, content: string): void {
  try {
    if (existsSync(fsPath(filePath)) && readFileSync(fsPath(filePath), 'utf8') === content) return;
  } catch {
    // Rewrite unreadable partial files.
  }
  writeFileSync(fsPath(filePath), content, 'utf8');
}

function buildLyclawCommandPolicyPluginEntry(): string {
  return `const PLUGIN_ID = 'lyclaw-command-policy';
const DEFAULT_TIMEOUT_MS = 70000;

function readString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function block(reason) {
  return { block: true, blockReason: reason };
}

const GENERATED_TEXT_EXTENSIONS = new Set(['py', 'js', 'ts', 'mjs', 'cjs', 'json', 'sh', 'ps1', 'bat', 'cmd']);
const MUTATING_TOOLS = new Set(['write', 'edit', 'delete', 'remove', 'rm', 'move', 'rename', 'apply_patch']);

function readPath(params) {
  return readString(params.file_path)
    || readString(params.filePath)
    || readString(params.path)
    || readString(params.filename)
    || readString(params.target);
}

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\\\/g, '/').toLowerCase();
}

function getExt(filePath) {
  const name = normalizePath(filePath).split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

function isGeneratedTextPath(filePath) {
  return !!filePath && GENERATED_TEXT_EXTENSIONS.has(getExt(filePath));
}

function isSkillSourcePath(filePath) {
  const path = normalizePath(filePath);
  return path.includes('/.openclaw/skills/')
    || path.includes('/openclaw/skills/')
    || path.includes('/.codex/skills/')
    || path.includes('/codex/skills/')
    || (path.includes('/plugins/cache/') && path.includes('/skills/'));
}

function containsNullByte(value) {
  if (typeof value === 'string') return value.includes('\\u0000');
  if (Array.isArray(value)) return value.some(containsNullByte);
  if (value && typeof value === 'object') return Object.values(value).some(containsNullByte);
  return false;
}

function readWriteContent(params) {
  return [params.content, params.new_string, params.old_string, params.command, params.script]
    .filter((value) => typeof value === 'string')
    .join('\\n');
}

function preflightGeneratedToolCall(toolName, params) {
  const lowerName = String(toolName || '').toLowerCase();
  const filePath = readPath(params);
  const command = readString(params.command) || readString(params.cmd) || '';

  if (MUTATING_TOOLS.has(lowerName) && isSkillSourcePath(filePath)) {
    return block('skill_source_readonly: installed skill source is read-only during ordinary tasks. Create a workspace runner/wrapper or report a skill defect.');
  }

  if (command && command.includes('\\u0000')) {
    return block('generated_code_null_bytes: command contains null bytes. Rewrite the command without embedded null bytes and avoid inline binary/script payloads.');
  }

  if (command && /\\bnode(?:\\.exe)?\\b/i.test(command) && /\\.py\\b/i.test(command)) {
    return block('wrong_interpreter: Python files must be run with python or uv run python, not node.');
  }

  if (command && command.includes('&&')) {
    return block('shell_operator_unsupported: PowerShell command chaining with && is not supported here. Run commands separately or use a PowerShell-safe command.');
  }

  if ((lowerName === 'write' || lowerName === 'edit' || lowerName === 'apply_patch')
    && isGeneratedTextPath(filePath)
    && containsNullByte(readWriteContent(params))) {
    return block('generated_code_null_bytes: generated text/code content contains null bytes. Regenerate UTF-8 text without null bytes before writing.');
  }

  if (containsNullByte(params)) {
    return block('generated_code_null_bytes: tool parameters contain null bytes. Regenerate the tool call without embedded null bytes.');
  }

  return undefined;
}
async function preflightExecCommand(input) {
  const port = process.env.CLAWX_HOST_API_PORT || '13210';
  const token = process.env.CLAWX_COMMAND_POLICY_TOKEN || '';
  if (!token) return block('LYClaw command policy is unavailable: missing Host API token');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(\`http://127.0.0.1:\${port}/api/security/command-policy/preflight\`, {
      method: 'POST',
      headers: {
        Authorization: \`Bearer \${token}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data && data.success === true) return undefined;
    return block(data && data.error
      ? \`Command blocked by LYClaw policy: \${data.error}\`
      : \`Command blocked by LYClaw policy: HTTP \${response.status}\`);
  } catch (error) {
    return block(\`LYClaw command policy preflight failed: \${error instanceof Error ? error.message : String(error)}\`);
  } finally {
    clearTimeout(timer);
  }
}

export default {
  id: PLUGIN_ID,
  name: 'LYClaw Command Policy',
  description: 'Preflights OpenClaw exec and generated-file tool calls before execution.',
  register(api) {
    api.on('before_tool_call', async (event, ctx) => {
      const params = event.params && typeof event.params === 'object' ? event.params : {};
      const generatedBlock = preflightGeneratedToolCall(event.toolName, params);
      if (generatedBlock) return generatedBlock;
      if (event.toolName !== 'exec') return undefined;
      const command = readString(params.command);
      if (!command) return block('Command blocked by LYClaw policy: missing command');
      const cwd = readString(params.workdir) || readString(params.cwd);
      return await preflightExecCommand({
        command,
        cwd,
        agentId: ctx && ctx.agentId,
        sessionKey: ctx && ctx.sessionKey,
        source: ctx && ctx.agentId ? \`gateway:runtime-exec:\${ctx.agentId}\` : 'gateway:runtime-exec',
      });
    }, { priority: 1000, timeoutMs: 75000 });
  },
};
`;
}

function ensureLyclawCommandPolicyPluginInstalled(): void {
  const targetDir = join(homedir(), '.openclaw', 'extensions', LYCLAW_COMMAND_POLICY_PLUGIN_ID);
  try {
    mkdirSync(fsPath(targetDir), { recursive: true });
    writeTextFileIfChanged(join(targetDir, 'openclaw.plugin.json'), JSON.stringify({
      id: LYCLAW_COMMAND_POLICY_PLUGIN_ID,
      activation: {
        onStartup: true,
        onCapabilities: ['hook'],
      },
      enabledByDefault: true,
      name: 'LYClaw Command Policy',
      description: 'Preflights OpenClaw exec and generated-file tool calls before execution.',
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    }, null, 2));
    writeTextFileIfChanged(join(targetDir, 'package.json'), JSON.stringify({
      name: '@lyclaw/command-policy-plugin',
      version: '1.0.0',
      private: true,
      type: 'module',
      openclaw: {
        extensions: ['./index.js'],
      },
    }, null, 2));
    writeTextFileIfChanged(join(targetDir, 'index.js'), buildLyclawCommandPolicyPluginEntry());
  } catch (err) {
    logger.warn('[plugin] Failed to install LYClaw command policy hook plugin:', err);
  }
}

function cleanupStaleBuiltInExtensions(): void {
  for (const ext of BUILTIN_CHANNEL_EXTENSIONS) {
    const extDir = join(homedir(), '.openclaw', 'extensions', ext);
    if (existsSync(fsPath(extDir))) {
      logger.info(`[plugin] Removing stale built-in extension copy: ${ext}`);
      try {
        rmSync(fsPath(extDir), { recursive: true, force: true });
      } catch (err) {
        logger.warn(`[plugin] Failed to remove stale extension ${ext}:`, err);
      }
    }
  }
}

function readPluginVersion(pkgJsonPath: string): string | null {
  try {
    const raw = readFileSync(fsPath(pkgJsonPath), 'utf-8');
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
}

function buildBundledPluginSources(pluginDirName: string): string[] {
  return app.isPackaged
    ? [
      join(process.resourcesPath, 'openclaw-plugins', pluginDirName),
      join(process.resourcesPath, 'app.asar.unpacked', 'build', 'openclaw-plugins', pluginDirName),
      join(process.resourcesPath, 'app.asar.unpacked', 'openclaw-plugins', pluginDirName),
    ]
    : [
      join(app.getAppPath(), 'build', 'openclaw-plugins', pluginDirName),
      join(process.cwd(), 'build', 'openclaw-plugins', pluginDirName),
    ];
}

/**
 * Auto-upgrade all configured channel plugins before Gateway start.
 * - Packaged mode: uses bundled plugins from resources/ (includes deps)
 * - Dev mode: falls back to node_modules/ with pnpm-aware dep collection
 */
function ensureConfiguredPluginsUpgraded(configuredChannels: string[]): void {
  for (const channelType of configuredChannels) {
    const pluginInfo = CHANNEL_PLUGIN_MAP[channelType];
    if (!pluginInfo) continue;
    const { dirName, npmName } = pluginInfo;

    const targetDir = join(homedir(), '.openclaw', 'extensions', dirName);
    const targetManifest = join(targetDir, 'openclaw.plugin.json');
    const isInstalled = existsSync(fsPath(targetManifest));
    const installedVersion = isInstalled ? readPluginVersion(join(targetDir, 'package.json')) : null;

    // Try bundled sources first (packaged mode or if bundle-plugins was run)
    const bundledSources = buildBundledPluginSources(dirName);
    const bundledDir = bundledSources.find((dir) => existsSync(fsPath(join(dir, 'openclaw.plugin.json'))));

    if (bundledDir) {
      const sourceVersion = readPluginVersion(join(bundledDir, 'package.json'));
      // Install or upgrade if version differs or plugin not installed
      if (!isInstalled || (sourceVersion && installedVersion && sourceVersion !== installedVersion)) {
        logger.info(`[plugin] ${isInstalled ? 'Auto-upgrading' : 'Installing'} ${channelType} plugin${isInstalled ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (bundled)`);
        try {
          mkdirSync(fsPath(join(homedir(), '.openclaw', 'extensions')), { recursive: true });
          rmSync(fsPath(targetDir), { recursive: true, force: true });
          cpSyncSafe(bundledDir, targetDir);
          fixupPluginManifest(targetDir);
        } catch (err) {
          logger.warn(`[plugin] Failed to ${isInstalled ? 'auto-upgrade' : 'install'} ${channelType} plugin:`, err);
        }
      } else if (isInstalled) {
        // Same version already installed — still patch manifest ID in case it was
        // never corrected (e.g. installed before MANIFEST_ID_FIXES included this plugin).
        fixupPluginManifest(targetDir);
      }
      continue;
    }

    // Dev mode fallback: copy from node_modules/ with pnpm dep resolution
    if (!app.isPackaged) {
      const npmPkgPath = join(process.cwd(), 'node_modules', ...npmName.split('/'));
      if (!existsSync(fsPath(join(npmPkgPath, 'openclaw.plugin.json')))) continue;
      const sourceVersion = readPluginVersion(join(npmPkgPath, 'package.json'));
      if (!sourceVersion) continue;
      // Skip only if installed AND same version — but still patch manifest ID.
      if (isInstalled && installedVersion && sourceVersion === installedVersion) {
        fixupPluginManifest(targetDir);
        continue;
      }

      logger.info(`[plugin] ${isInstalled ? 'Auto-upgrading' : 'Installing'} ${channelType} plugin${isInstalled ? `: ${installedVersion} → ${sourceVersion}` : `: ${sourceVersion}`} (dev/node_modules)`);

      try {
        mkdirSync(fsPath(join(homedir(), '.openclaw', 'extensions')), { recursive: true });
        copyPluginFromNodeModules(npmPkgPath, targetDir, npmName);
        fixupPluginManifest(targetDir);
      } catch (err) {
        logger.warn(`[plugin] Failed to ${isInstalled ? 'auto-upgrade' : 'install'} ${channelType} plugin from node_modules:`, err);
      }
    }
  }
}

/**
 * Remove channel plugin extensions from ~/.openclaw/extensions/ when their
 * corresponding channel is no longer configured.  This prevents the Gateway
 * from scanning residual plugin manifests that were installed by a previous
 * configuration but are no longer needed.
 */
function cleanupUnconfiguredChannelPlugins(configuredChannels: string[]): void {
  const configuredSet = new Set(configuredChannels);
  const staleWeComDir = join(homedir(), '.openclaw', 'extensions', 'wecom');
  if (existsSync(fsPath(staleWeComDir))) {
    logger.info('[plugin] Removing stale WeCom plugin directory: wecom');
    try {
      rmSync(fsPath(staleWeComDir), { recursive: true, force: true });
    } catch (err) {
      logger.warn('[plugin] Failed to remove stale WeCom plugin directory:', err);
    }
  }

  for (const [channelType, pluginInfo] of Object.entries(CHANNEL_PLUGIN_MAP)) {
    if (configuredSet.has(channelType)) continue;

    const { dirName } = pluginInfo;
    const targetDir = join(homedir(), '.openclaw', 'extensions', dirName);
    if (!existsSync(fsPath(targetDir))) continue;

    logger.info(`[plugin] Removing unconfigured channel plugin: ${channelType} (${dirName})`);
    try {
      rmSync(fsPath(targetDir), { recursive: true, force: true });
    } catch (err) {
      logger.warn(`[plugin] Failed to remove unconfigured channel plugin ${channelType}:`, err);
    }
  }
}

/**
 * Ensure extension-specific packages are resolvable from shared dist/ chunks.
 *
 * OpenClaw's Rollup bundler creates shared chunks in dist/ (e.g.
 * sticker-cache-*.js) that eagerly `import "grammy"`.  ESM bare specifier
 * resolution walks from the importing file's directory upward:
 *   dist/node_modules/ → openclaw/node_modules/ → …
 * It does NOT search `dist/extensions/telegram/node_modules/`.
 *
 * NODE_PATH only works for CJS require(), NOT for ESM import statements.
 *
 * Fix: create symlinks in openclaw/node_modules/ pointing to packages in
 * dist/extensions/<ext>/node_modules/.  This makes the standard ESM
 * resolution algorithm find them.  Skip-if-exists avoids overwriting
 * openclaw's own deps (they take priority).
 */
let _extensionDepsLinked = false;

/**
 * Reset the extension-deps-linked cache so the next
 * ensureExtensionDepsResolvable() call re-scans and links.
 * Called before each Gateway launch to pick up newly installed extensions.
 */
export function resetExtensionDepsLinked(): void {
  _extensionDepsLinked = false;
}

function ensureExtensionDepsResolvable(openclawDir: string): void {
  if (_extensionDepsLinked) return;

  const extDir = join(openclawDir, 'dist', 'extensions');
  const topNM = join(openclawDir, 'node_modules');
  let linkedCount = 0;

  try {
    if (!existsSync(extDir)) return;

    for (const ext of readdirSync(extDir, { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const extNM = join(extDir, ext.name, 'node_modules');
      if (!existsSync(extNM)) continue;

      for (const pkg of readdirSync(extNM, { withFileTypes: true })) {
        if (pkg.name === '.bin') continue;

        if (pkg.name.startsWith('@')) {
          // Scoped package — iterate sub-entries
          const scopeDir = join(extNM, pkg.name);
          let scopeEntries;
          try { scopeEntries = readdirSync(scopeDir, { withFileTypes: true }); } catch { continue; }
          for (const sub of scopeEntries) {
            if (!sub.isDirectory()) continue;
            const dest = join(topNM, pkg.name, sub.name);
            if (existsSync(dest)) continue;
            try {
              mkdirSync(join(topNM, pkg.name), { recursive: true });
              symlinkSync(join(scopeDir, sub.name), dest);
              linkedCount++;
            } catch { /* skip on error — non-fatal */ }
          }
        } else {
          const dest = join(topNM, pkg.name);
          if (existsSync(dest)) continue;
          try {
            mkdirSync(topNM, { recursive: true });
            symlinkSync(join(extNM, pkg.name), dest);
            linkedCount++;
          } catch { /* skip on error — non-fatal */ }
        }
      }
    }
  } catch {
    // extensions dir may not exist or be unreadable — non-fatal
  }

  if (linkedCount > 0) {
    logger.info(`[extension-deps] Linked ${linkedCount} extension packages into ${topNM}`);
  }

  _extensionDepsLinked = true;
}

// ── Pre-launch sync ──────────────────────────────────────────────

export async function syncGatewayConfigBeforeLaunch(
  appSettings: Awaited<ReturnType<typeof getAllSettings>>,
): Promise<void> {
  // Reset the extension-deps cache so that newly installed extensions
  // (e.g. user added a channel while the app was running) get their
  // node_modules linked on the next Gateway spawn.
  resetExtensionDepsLinked();
  ensureLyclawCommandPolicyPluginInstalled();

  // Sanitize first so plugin upgrade sees a valid config shape.
  await Promise.allSettled([
    syncProxyConfigToOpenClaw(appSettings, { preserveExistingWhenDisabled: true }).catch((err) => {
      logger.warn('Failed to sync proxy config:', err);
    }),

    cleanupDanglingWeChatPluginState().catch((err) => {
      logger.warn('Failed to clean dangling WeChat plugin state before launch:', err);
    }),

    Promise.resolve().then(() => {
      try {
        cleanupStaleBuiltInExtensions();
      } catch (err) {
        logger.warn('Failed to clean stale built-in extensions:', err);
      }
    }),
  ]);

  try {
    await sanitizeOpenClawConfig();
  } catch (err) {
    logger.warn('Failed to sanitize openclaw.json:', err);
  }

  try {
    const repaired = await ensureAgentModelsJsonValid();
    if (repaired) {
      logger.info('[GatewaySync] Repaired agent models.json schema before launch');
    }
  } catch (err) {
    logger.warn('Failed to repair agent models.json before launch:', err);
  }

  // Plugin upgrade must run after sanitize completes (depends on config)
  try {
    const rawCfg = await readOpenClawConfig();
    const configuredChannels = await listConfiguredChannelsFromConfig(rawCfg);

    ensureConfiguredPluginsUpgraded(configuredChannels);
    cleanupUnconfiguredChannelPlugins(configuredChannels);

    // Auto-create dingtalk agent + binding when dingtalk channel is configured
    if (configuredChannels.includes('dingtalk')) {
      try {
        await ensureDingTalkDedicatedAgent();
        const channelAccounts = listConfiguredChannelAccountsFromConfig(rawCfg);
        const dingtalkAccounts = channelAccounts['dingtalk']?.accountIds ?? ['default'];
        for (const accountId of dingtalkAccounts) {
          const existingOwner = await getChannelAccountBindingOwner('dingtalk', accountId);
          if (!existingOwner) {
            await assignChannelAccountToAgent(DINGTALK_DEDICATED_AGENT_ID, 'dingtalk', accountId);
          }
        }
        logger.info('[GatewaySync] Ensured dingtalk agent + channel bindings');
      } catch (err) {
        logger.warn('[GatewaySync] Failed to ensure dingtalk agent:', err);
      }
    }
  } catch (err) {
    logger.warn('Failed to auto-upgrade plugins:', err);
  }

  // Batch gateway token, browser config, and session idle into one read+write cycle.
  try {
    await batchSyncConfigFields(appSettings.gatewayToken);
  } catch (err) {
    logger.warn('Failed to batch-sync config fields to openclaw.json:', err);
  }
}

async function loadProviderEnv(): Promise<{ providerEnv: Record<string, string>; loadedProviderKeyCount: number }> {
  const providerEnv: Record<string, string> = {};
  const providerTypes = getKeyableProviderTypes();
  let loadedProviderKeyCount = 0;

  try {
    const defaultProviderId = await getDefaultProvider();
    if (defaultProviderId) {
      const defaultProvider = await getProvider(defaultProviderId);
      const defaultProviderType = defaultProvider?.type;
      const defaultProviderKey = await getApiKey(defaultProviderId);
      if (defaultProviderType && defaultProviderKey) {
        const envVar = getProviderEnvVar(defaultProviderType);
        if (envVar) {
          providerEnv[envVar] = defaultProviderKey;
          loadedProviderKeyCount++;
        }
      }
    }
  } catch (err) {
    logger.warn('Failed to load default provider key for environment injection:', err);
  }

  for (const providerType of providerTypes) {
    try {
      const key = await getApiKey(providerType);
      if (key) {
        const envVar = getProviderEnvVar(providerType);
        if (envVar) {
          providerEnv[envVar] = key;
          loadedProviderKeyCount++;
        }
      }
    } catch (err) {
      logger.warn(`Failed to load API key for ${providerType}:`, err);
    }
  }

  return { providerEnv, loadedProviderKeyCount };
}

async function resolveChannelStartupPolicy(): Promise<{
  skipChannels: boolean;
  channelStartupSummary: string;
}> {
  // Skip channel adapters only when nothing is configured: faster cold start.
  // If openclaw.json already has channels (e.g. dingtalk Stream), we must not set
  // OPENCLAW_SKIP_CHANNELS — lazy init may never attach and the UI stays disconnected.
  try {
    const rawCfg = await readOpenClawConfig();
    const configuredChannels = await listConfiguredChannelsFromConfig(rawCfg);
    const skipChannels = configuredChannels.length === 0;

    return {
      skipChannels,
      channelStartupSummary: skipChannels
        ? 'skipped(no configured channels)'
        : `startup(${configuredChannels.join(',')})`,
    };
  } catch (error) {
    logger.warn('Failed to determine configured channels for gateway launch:', error);
    return {
      skipChannels: true,
      channelStartupSummary: 'skipped(unknown)',
    };
  }
}

export async function prepareGatewayLaunchContext(port: number): Promise<GatewayLaunchContext> {
  const openclawDir = getOpenClawDir();
  const entryScript = getOpenClawEntryPath();

  if (!isOpenClawPresent()) {
    throw new Error(`OpenClaw package not found at: ${openclawDir}`);
  }

  const appSettings = await getAllSettings();
  await syncGatewayConfigBeforeLaunch(appSettings);

  if (process.platform === 'win32') {
    await ensureBundledNodeReady();
    if (!hasNpmCliRuntime()) {
      logger.warn(
        '[gateway-launch] npm-cli.js is unavailable (bundled + system); OpenClaw doctor and plugin runtime deps may fail on Windows.',
      );
    }
  }

  if (!existsSync(entryScript)) {
    throw new Error(`OpenClaw entry script not found at: ${entryScript}`);
  }

  const isolationStatus = await inspectOpenClawDigitalEmployeeIsolation(openclawDir);
  if (isolationStatus.ok) {
    logger.info(`[digital-employee-isolation] OpenClaw runtime verified: ${isolationStatus.openclawDir}`);
  } else {
    logger.warn('[digital-employee-isolation] OpenClaw runtime is missing digital employee resource isolation markers; @agent execution will continue but may load global resources.', {
      openclawDir: isolationStatus.openclawDir,
      missing: isolationStatus.missing,
      details: isolationStatus.details,
    });
  }

  const gatewayArgs = ['gateway', '--port', String(port), '--token', appSettings.gatewayToken, '--allow-unconfigured', '--verbose'];
  const mode = app.isPackaged ? 'packaged' : 'dev';

  const binPath = getBundledBinDir();
  const bundledBinReady = hasBundledNpmRuntime();
  const npmRuntimeReady = hasNpmCliRuntime();
  const binPathExists = bundledBinReady || existsSync(binPath);

  const { providerEnv, loadedProviderKeyCount } = await loadProviderEnv();
  const { skipChannels, channelStartupSummary } = await resolveChannelStartupPolicy();
  const uvEnv = await getUvMirrorEnv();
  const proxyEnv = buildProxyEnv(appSettings);
  const resolvedProxy = resolveProxySettings(appSettings);
  const proxySummary = appSettings.proxyEnabled
    ? `http=${resolvedProxy.httpProxy || '-'}, https=${resolvedProxy.httpsProxy || '-'}, all=${resolvedProxy.allProxy || '-'}`
    : 'disabled';

  const { NODE_OPTIONS: _nodeOptions, ...baseEnv } = process.env;
  const baseEnvRecord = baseEnv as Record<string, string | undefined>;
  const baseEnvWithBundledBin = binPathExists
    ? prependPathEntry(baseEnvRecord, binPath).env
    : baseEnvRecord;
  // Agent exec/command tools run in non-interactive shells and do not source
  // ~/.zshrc, ~/.bashrc, or Windows' refreshed user environment. Put the
  // user-level DWS install directory directly into Gateway PATH so commands
  // like `dws ...` can resolve the same external ~/.dws binary.
  const baseEnvPatched = prependPathEntry(baseEnvWithBundledBin, getDwsDir()).env;
  const managedPythonEnv = await getManagedPythonEnv(stripSystemdSupervisorEnv(baseEnvPatched));

  const forkEnv: Record<string, string | undefined> = buildBundledNpmEnv({
    ...managedPythonEnv,
    ...providerEnv,
    ...uvEnv,
    ...proxyEnv,
    OPENCLAW_GATEWAY_TOKEN: appSettings.gatewayToken,
    CLAWX_HOST_API_PORT: String(getPort('CLAWX_HOST_API')),
    CLAWX_COMMAND_POLICY_TOKEN: getCommandPolicyPreflightToken(),
    ...(skipChannels
      ? { OPENCLAW_SKIP_CHANNELS: '1', CLAWDBOT_SKIP_CHANNELS: '1' }
      : {}),
    OPENCLAW_NO_RESPAWN: '1',
    OPENCLAW_DISABLE_BONJOUR: '1',
    OPENCLAW_DISABLE_MODEL_PRICING: '1',
    OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: '1',
    // OPENCLAW_OFFLINE_MODE: '1',
    // OPENCLAW_NETWORK_TIMEOUT: '1',
    LITELLM_DISABLE_COST_TRACKING: 'true',
    // Additional optimizations for faster startup
  });

  // Ensure extension-specific packages (e.g. grammy from the telegram
  // extension) are resolvable by shared dist/ chunks via symlinks in
  // openclaw/node_modules/.  NODE_PATH does NOT work for ESM imports.
  ensureExtensionDepsResolvable(openclawDir);

  return {
    appSettings,
    openclawDir,
    entryScript,
    gatewayArgs,
    forkEnv,
    mode,
    binPathExists,
    npmRuntimeReady,
    loadedProviderKeyCount,
    proxySummary,
    channelStartupSummary,
  };
}
