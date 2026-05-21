import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { extensionRegistry } from './registry';
import type { Extension } from './types';

interface ExtensionManifest {
  extensions?: {
    main?: string[];
  };
}

const builtinModules = new Map<string, () => Extension>();

export function registerBuiltinExtension(id: string, factory: () => Extension): void {
  builtinModules.set(id, factory);
}

function resolveManifestPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'clawx-extensions.json');
  }
  return join(app.getAppPath(), 'clawx-extensions.json');
}

export async function loadExtensionsFromManifest(): Promise<void> {
  const manifestPath = resolveManifestPath();
  let manifest: ExtensionManifest = {};

  console.log('[extensions] resolveManifestPath:', manifestPath);
  console.log('[extensions] app.isPackaged:', app.isPackaged);
  console.log('[extensions] process.resourcesPath:', process.resourcesPath);
  console.log('[extensions] builtinModules keys:', Array.from(builtinModules.keys()));

  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as ExtensionManifest;
      console.log(`[extensions] Loaded manifest from ${manifestPath}: ${JSON.stringify(manifest)}`);
      logger.info(`[extensions] Loaded manifest from ${manifestPath}: ${JSON.stringify(manifest)}`);
    } catch (err) {
      logger.warn(`[extensions] Failed to parse ${manifestPath}, using defaults:`, err);
    }
  } else {
    console.log('[extensions] No clawx-extensions.json found, loading all builtin extensions');
    logger.debug('[extensions] No clawx-extensions.json found, loading all builtin extensions');
  }

  const mainExtensions = manifest.extensions?.main;
  console.log('[extensions] mainExtensions:', mainExtensions);

  if (!mainExtensions || mainExtensions.length === 0) {
    console.log('[extensions] No manifest extensions, auto-registering all builtin extensions');
    for (const [id, factory] of builtinModules) {
      extensionRegistry.register(factory());
      console.log(`[extensions] Auto-registered builtin extension "${id}"`);
      logger.debug(`[extensions] Auto-registered builtin extension "${id}"`);
    }
    return;
  }

  for (const extensionId of mainExtensions) {
    console.log('[extensions] Processing extension:', extensionId);
    if (builtinModules.has(extensionId)) {
      console.log('[extensions] Registering builtin extension:', extensionId);
      extensionRegistry.register(builtinModules.get(extensionId)!());
      continue;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(extensionId) as { default?: Extension; extension?: Extension };
      const ext = mod.default ?? mod.extension;
      if (ext && typeof ext.setup === 'function') {
        extensionRegistry.register(ext);
      } else {
        logger.warn(`[extensions] Module "${extensionId}" does not export a valid Extension`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Cannot find module')) {
        logger.debug(`[extensions] "${extensionId}" not loadable at runtime (expected when using ext-bridge)`);
      } else {
        logger.warn(`[extensions] Failed to load extension "${extensionId}": ${message}`);
      }
    }
  }
}
