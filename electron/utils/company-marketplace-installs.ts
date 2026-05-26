import * as fs from 'fs';
import * as path from 'path';
import { getOpenClawConfigDir } from './paths';

export const COMPANY_MARKETPLACE_SIDECAR = '.lyclaw-marketplace.json';

export interface CompanyMarketplaceInstallEntry {
  packageSlug: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
}

export interface CompanyMarketplaceInstallRegistry {
  byMarketplaceId: Record<string, CompanyMarketplaceInstallEntry>;
}

interface CompanyMarketplaceApiSkill {
  id: number;
  name: string;
  version: string;
  author: string;
  skill_detail: string;
}

const COMPANY_API_BASE = 'http://portal.srv.lstech.com/aihome/api/skill';

function getRegistryPath(): string {
  return path.join(getOpenClawConfigDir(), '.lyclaw', 'company-marketplace-installs.json');
}

function emptyRegistry(): CompanyMarketplaceInstallRegistry {
  return { byMarketplaceId: {} };
}

function normalizeEntry(
  marketplaceId: string,
  value: unknown,
): CompanyMarketplaceInstallEntry | undefined {
  if (typeof value === 'string') {
    const packageSlug = value.trim();
    if (!packageSlug) return undefined;
    return {
      packageSlug,
      name: '',
      version: '',
    };
  }

  if (!value || typeof value !== 'object') return undefined;
  const record = value as Partial<CompanyMarketplaceInstallEntry>;
  const packageSlug = record.packageSlug?.trim();
  if (!packageSlug) return undefined;

  return {
    packageSlug,
    name: record.name?.trim() || '',
    version: record.version?.trim() || '',
    author: record.author?.trim() || undefined,
    description: record.description?.trim() || undefined,
  };
}

function normalizeRegistry(raw: unknown): CompanyMarketplaceInstallRegistry {
  if (!raw || typeof raw !== 'object') return emptyRegistry();
  const parsed = raw as { byMarketplaceId?: Record<string, unknown> };
  if (!parsed.byMarketplaceId || typeof parsed.byMarketplaceId !== 'object') {
    return emptyRegistry();
  }

  const byMarketplaceId: Record<string, CompanyMarketplaceInstallEntry> = {};
  for (const [marketplaceId, value] of Object.entries(parsed.byMarketplaceId)) {
    const entry = normalizeEntry(marketplaceId, value);
    if (entry) byMarketplaceId[marketplaceId] = entry;
  }
  return { byMarketplaceId };
}

export async function fetchCompanyMarketplaceSkills(): Promise<CompanyMarketplaceApiSkill[]> {
  const response = await fetch(`${COMPANY_API_BASE}/list/`, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`Company API error: ${response.status}`);
  }

  const data = await response.json();
  if (!data || typeof data !== 'object' || !Array.isArray((data as { skills?: unknown }).skills)) {
    throw new Error('Invalid company marketplace response');
  }
  return (data as { skills: CompanyMarketplaceApiSkill[] }).skills;
}

function mergeApiSkillMetadata(
  entry: CompanyMarketplaceInstallEntry,
  apiSkill: CompanyMarketplaceApiSkill | undefined,
): CompanyMarketplaceInstallEntry {
  if (!apiSkill) return entry;
  return {
    packageSlug: entry.packageSlug,
    name: entry.name || apiSkill.name,
    version: entry.version || apiSkill.version,
    author: entry.author || apiSkill.author,
    description: entry.description || apiSkill.skill_detail,
  };
}

async function writeCompanyMarketplaceInstallRegistry(registry: CompanyMarketplaceInstallRegistry): Promise<void> {
  const registryPath = getRegistryPath();
  await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.promises.writeFile(registryPath, JSON.stringify(registry, null, 2), 'utf8');
}

export async function writeCompanyMarketplaceSidecar(
  skillDir: string,
  marketplaceId: number | string,
  entry: CompanyMarketplaceInstallEntry,
): Promise<void> {
  const payload = {
    marketplaceId: Number(marketplaceId) || marketplaceId,
    packageSlug: entry.packageSlug,
    name: entry.name,
    version: entry.version,
    author: entry.author,
    description: entry.description,
  };
  await fs.promises.writeFile(
    path.join(skillDir, COMPANY_MARKETPLACE_SIDECAR),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

export async function readCompanyMarketplaceSidecar(
  skillDir: string,
): Promise<CompanyMarketplaceInstallEntry | undefined> {
  try {
    const raw = await fs.promises.readFile(path.join(skillDir, COMPANY_MARKETPLACE_SIDECAR), 'utf8');
    return parseCompanyMarketplaceSidecar(raw);
  } catch {
    return undefined;
  }
}

export function readCompanyMarketplaceSidecarSync(
  skillDir: string,
): CompanyMarketplaceInstallEntry | undefined {
  try {
    const raw = fs.readFileSync(path.join(skillDir, COMPANY_MARKETPLACE_SIDECAR), 'utf8');
    return parseCompanyMarketplaceSidecar(raw);
  } catch {
    return undefined;
  }
}

function parseCompanyMarketplaceSidecar(raw: string): CompanyMarketplaceInstallEntry | undefined {
  const parsed = JSON.parse(raw) as Partial<CompanyMarketplaceInstallEntry & { marketplaceId?: number | string }>;
  const packageSlug = parsed.packageSlug?.trim();
  if (!packageSlug) return undefined;
  return {
    packageSlug,
    name: parsed.name?.trim() || '',
    version: parsed.version?.trim() || '',
    author: parsed.author?.trim() || undefined,
    description: parsed.description?.trim() || undefined,
  };
}

export async function readCompanyMarketplaceInstallRegistry(): Promise<CompanyMarketplaceInstallRegistry> {
  const registryPath = getRegistryPath();
  try {
    const raw = await fs.promises.readFile(registryPath, 'utf8');
    return normalizeRegistry(JSON.parse(raw));
  } catch {
    return emptyRegistry();
  }
}

export async function hydrateCompanyMarketplaceInstallRegistry(
  registry: CompanyMarketplaceInstallRegistry = emptyRegistry(),
): Promise<CompanyMarketplaceInstallRegistry> {
  const entries = Object.entries(registry.byMarketplaceId);
  if (entries.length === 0) return registry;

  const needsHydration = entries.some(([, entry]) => !entry.name || !entry.version);
  if (!needsHydration) return registry;

  try {
    const apiSkills = await fetchCompanyMarketplaceSkills();
    const apiById = new Map(apiSkills.map((skill) => [String(skill.id), skill]));
    let changed = false;
    const next: CompanyMarketplaceInstallRegistry = { byMarketplaceId: {} };

    for (const [marketplaceId, entry] of entries) {
      const merged = mergeApiSkillMetadata(entry, apiById.get(marketplaceId));
      next.byMarketplaceId[marketplaceId] = merged;
      if (
        merged.name !== entry.name
        || merged.version !== entry.version
        || merged.author !== entry.author
        || merged.description !== entry.description
      ) {
        changed = true;
      }

      const skillDir = path.join(getOpenClawConfigDir(), 'skills', merged.packageSlug);
      if (fs.existsSync(skillDir)) {
        await writeCompanyMarketplaceSidecar(skillDir, marketplaceId, merged);
      }
    }

    if (changed) {
      await writeCompanyMarketplaceInstallRegistry(next);
    }
    return changed ? next : registry;
  } catch (error) {
    console.warn('[CompanyMarketplaceInstalls] Failed to hydrate registry from API:', error);
    return registry;
  }
}

export async function rememberCompanyMarketplaceInstall(
  marketplaceId: number | string,
  entry: CompanyMarketplaceInstallEntry,
): Promise<void> {
  const id = String(marketplaceId).trim();
  const packageSlug = entry.packageSlug.trim();
  if (!id || !packageSlug) return;

  const registry = await readCompanyMarketplaceInstallRegistry();
  registry.byMarketplaceId[id] = {
    packageSlug,
    name: entry.name.trim(),
    version: entry.version.trim(),
    author: entry.author?.trim() || undefined,
    description: entry.description?.trim() || undefined,
  };
  await writeCompanyMarketplaceInstallRegistry(registry);
}

export async function forgetCompanyMarketplaceInstall(marketplaceId: number | string): Promise<void> {
  const id = String(marketplaceId).trim();
  if (!id) return;

  const registry = await readCompanyMarketplaceInstallRegistry();
  const entry = registry.byMarketplaceId[id];
  if (!entry) return;

  delete registry.byMarketplaceId[id];
  await writeCompanyMarketplaceInstallRegistry(registry);

  const sidecarPath = path.join(getOpenClawConfigDir(), 'skills', entry.packageSlug, COMPANY_MARKETPLACE_SIDECAR);
  await fs.promises.unlink(sidecarPath).catch(() => undefined);
}

export async function resolveCompanyMarketplacePackageSlug(
  marketplaceId: number | string,
): Promise<string | undefined> {
  const id = String(marketplaceId).trim();
  if (!id) return undefined;
  const registry = await readCompanyMarketplaceInstallRegistry();
  return registry.byMarketplaceId[id]?.packageSlug;
}

export function buildCompanyInstallLookupByPackageSlug(
  registry: CompanyMarketplaceInstallRegistry,
): Record<string, CompanyMarketplaceInstallEntry & { marketplaceId: string }> {
  const byPackageSlug: Record<string, CompanyMarketplaceInstallEntry & { marketplaceId: string }> = {};
  for (const [marketplaceId, entry] of Object.entries(registry.byMarketplaceId)) {
    byPackageSlug[entry.packageSlug] = { ...entry, marketplaceId };
  }
  return byPackageSlug;
}

export async function loadCompanyMarketplaceInstallState(): Promise<{
  registry: CompanyMarketplaceInstallRegistry;
  byPackageSlug: Record<string, CompanyMarketplaceInstallEntry & { marketplaceId: string }>;
}> {
  let registry = await hydrateCompanyMarketplaceInstallRegistry(await readCompanyMarketplaceInstallRegistry());
  registry = await reconcileRegistryFromSidecars(registry);
  return {
    registry,
    byPackageSlug: buildCompanyInstallLookupByPackageSlug(registry),
  };
}

async function reconcileRegistryFromSidecars(
  registry: CompanyMarketplaceInstallRegistry,
): Promise<CompanyMarketplaceInstallRegistry> {
  const skillsRoot = path.join(getOpenClawConfigDir(), 'skills');
  if (!fs.existsSync(skillsRoot)) return registry;

  let changed = false;
  const next: CompanyMarketplaceInstallRegistry = {
    byMarketplaceId: { ...registry.byMarketplaceId },
  };

  const entries = fs.readdirSync(skillsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const sidecarPath = path.join(skillDir, COMPANY_MARKETPLACE_SIDECAR);
    if (!fs.existsSync(sidecarPath)) continue;

    try {
      const raw = fs.readFileSync(sidecarPath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CompanyMarketplaceInstallEntry & { marketplaceId?: number | string }>;
      const marketplaceId = parsed.marketplaceId != null ? String(parsed.marketplaceId).trim() : '';
      const packageSlug = parsed.packageSlug?.trim() || entry.name;
      if (!marketplaceId) continue;

      const existing = next.byMarketplaceId[marketplaceId];
      const merged: CompanyMarketplaceInstallEntry = {
        packageSlug,
        name: parsed.name?.trim() || existing?.name || '',
        version: parsed.version?.trim() || existing?.version || '',
        author: parsed.author?.trim() || existing?.author,
        description: parsed.description?.trim() || existing?.description,
      };
      if (
        !existing
        || existing.packageSlug !== merged.packageSlug
        || existing.name !== merged.name
        || existing.version !== merged.version
      ) {
        next.byMarketplaceId[marketplaceId] = merged;
        changed = true;
      }
    } catch {
      // ignore invalid sidecars
    }
  }

  if (changed) {
    await writeCompanyMarketplaceInstallRegistry(next);
    return next;
  }
  return registry;
}
