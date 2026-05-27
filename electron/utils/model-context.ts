import { readOpenClawConfig } from './channel-config';
import { getProviderConfig } from './provider-registry';

interface RuntimeModelEntry {
  id?: unknown;
  name?: unknown;
  contextWindow?: unknown;
}

interface RuntimeProviderEntry {
  models?: unknown;
}

function parseModelRef(modelRef: string | null | undefined): { provider: string; modelId: string } | null {
  if (!modelRef) return null;
  const slash = modelRef.indexOf('/');
  if (slash <= 0 || slash >= modelRef.length - 1) return null;
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

function readContextWindow(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function getRuntimeModelsProvider(config: Record<string, unknown>, provider: string): RuntimeProviderEntry | null {
  const modelsRoot = config.models;
  if (!modelsRoot || typeof modelsRoot !== 'object') return null;
  const providers = (modelsRoot as Record<string, unknown>).providers;
  if (!providers || typeof providers !== 'object') return null;
  const entry = (providers as Record<string, unknown>)[provider];
  return entry && typeof entry === 'object' ? entry as RuntimeProviderEntry : null;
}

function findModelContextWindow(models: unknown, modelId: string): number | null {
  if (!Array.isArray(models)) return null;
  for (const model of models as RuntimeModelEntry[]) {
    if (!model || typeof model !== 'object') continue;
    const id = typeof model.id === 'string' ? model.id : '';
    const name = typeof model.name === 'string' ? model.name : '';
    if (id === modelId || name === modelId) {
      return readContextWindow(model.contextWindow);
    }
  }
  return null;
}

export async function resolveModelContextWindow(modelRef: string | null | undefined): Promise<number | null> {
  const parsed = parseModelRef(modelRef);
  if (!parsed) return null;

  const config = await readOpenClawConfig() as Record<string, unknown>;
  const runtimeProvider = getRuntimeModelsProvider(config, parsed.provider);
  const runtimeContextWindow = findModelContextWindow(runtimeProvider?.models, parsed.modelId);
  if (runtimeContextWindow) {
    return runtimeContextWindow;
  }

  const registryContextWindow = findModelContextWindow(getProviderConfig(parsed.provider)?.models, parsed.modelId);
  return registryContextWindow;
}
