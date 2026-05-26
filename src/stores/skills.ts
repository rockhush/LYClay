/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';
import { AppError, normalizeAppError } from '@/lib/error-model';
import { reportSkillDownload } from '@/lib/usage-reporter';
import {
  enrichSkillsWithMarketplaceMetadata,
  findExistingInstalledSkill,
  isPlaceholderSkillDescription,
  isSkillPresentOnDisk,
  mergeSkillWithMarketplaceMetadata,
  normalizeBaseDirKey,
  normalizeSkillLookupKey,
  shouldIncludeInMySkills,
  dedupeInstalledSkills,
  companyInstallEntriesToMarketplaceSkills,
} from '@/lib/skill-metadata';
import { useGatewayStore } from './gateway';
import type { Skill, MarketplaceSkill } from '../types/skill';

/**
 * 内置技能白名单 - 只保留这些技能
 */
const ALLOWED_BUILTIN_SKILLS = new Set([
  'pdf',
  'docx',
  'docxt',
  'pptx',
  'xlsx',
  'summarize',
  'github',
  'gh-issues',
  'coding',
  'coding-agent',
  'taskflow',
  'skill-creator',
  'find-skills',
  'session-logs',
  'brave-web-search',
  'self-improving-agent',
  'healthcheck',
  'tavily-search',
  'dws',
  'lingyi-baishitong',
]);

const SKILLS_GATEWAY_RPC_TIMEOUT_MS = 8_000;

type GatewaySkillStatus = {
  skillKey: string;
  slug?: string;
  name?: string;
  description?: string;
  disabled?: boolean;
  emoji?: string;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  bundled?: boolean;
  always?: boolean;
  source?: string;
  baseDir?: string;
  filePath?: string;
};

type GatewaySkillsStatusResult = {
  skills?: GatewaySkillStatus[];
};

type ClawHubListResult = {
  slug: string;
  name?: string;
  description?: string;
  author?: string;
  version?: string;
  source?: string;
  baseDir?: string;
};

function applyClawHubMetadata(existing: Skill, cs: ClawHubListResult): void {
  if (cs.baseDir) {
    existing.baseDir = cs.baseDir;
  }
  if (!existing.source && cs.source) {
    existing.source = cs.source;
  }

  const sharesBaseDir = Boolean(
    cs.baseDir
    && existing.baseDir
    && normalizeBaseDirKey(cs.baseDir) === normalizeBaseDirKey(existing.baseDir),
  );

  if (cs.name?.trim()) {
    if (
      sharesBaseDir
      || !existing.name
      || existing.name === existing.slug
      || existing.name === existing.id
    ) {
      existing.name = cs.name.trim();
    }
  }
  if (cs.description?.trim() && isPlaceholderSkillDescription(existing.description)) {
    existing.description = cs.description.trim();
  }
  if (cs.author?.trim() && !existing.author) {
    existing.author = cs.author.trim();
  }
  if (cs.version?.trim()) {
    const clawhubVersion = cs.version.trim().toLowerCase() === 'unknown' ? 'unknown' : cs.version.trim();
    if (sharesBaseDir || !existing.version || existing.version.toLowerCase() === 'unknown') {
      existing.version = clawhubVersion;
    }
  } else if (sharesBaseDir && !existing.isBundled && !existing.isCore) {
    existing.version = 'unknown';
  }
}

type SkillConfigEntry = { apiKey?: string; env?: Record<string, string>; enabled?: boolean };

function buildSkillConfigLookup(configResult: Record<string, SkillConfigEntry>) {
  const byKey = new Map<string, SkillConfigEntry>();
  const byNormalized = new Map<string, SkillConfigEntry>();

  for (const [key, entry] of Object.entries(configResult)) {
    byKey.set(key, entry);
    byNormalized.set(normalizeSkillLookupKey(key), entry);
  }

  return { byKey, byNormalized };
}

function resolveDirectSkillConfig(
  candidates: Array<string | undefined>,
  lookup: ReturnType<typeof buildSkillConfigLookup>,
): SkillConfigEntry | undefined {
  for (const candidate of candidates) {
    if (!candidate?.trim()) continue;
    const direct = lookup.byKey.get(candidate);
    if (direct) return direct;
    const normalized = lookup.byNormalized.get(normalizeSkillLookupKey(candidate));
    if (normalized) return normalized;
  }
  return undefined;
}

function mapErrorCodeToSkillErrorKey(
  code: AppError['code'],
  operation: 'fetch' | 'search' | 'install',
): string {
  if (code === 'TIMEOUT') {
    return operation === 'search'
      ? 'searchTimeoutError'
      : operation === 'install'
        ? 'installTimeoutError'
        : 'fetchTimeoutError';
  }
  if (code === 'RATE_LIMIT') {
    return operation === 'search'
      ? 'searchRateLimitError'
      : operation === 'install'
        ? 'installRateLimitError'
        : 'fetchRateLimitError';
  }
  // 返回通用错误，避免将所有未知错误映射为rateLimitError
  return `${operation}Error`;
}

interface CompanyInstallEntry {
  packageSlug: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
}

export interface SkillUpdateInfo {
  hasUpdate: boolean;
  latestVersion?: string;
  skillName?: string;
  error?: string;
}

interface SkillsState {
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  companyInstallMap: Record<string, string>;
  companyInstallEntries: Record<string, CompanyInstallEntry>;
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  checkingUpdates: boolean;
  skillUpdates: Record<string, SkillUpdateInfo>;
  error: string | null;

  // Actions
  fetchSkills: () => Promise<void>;
  searchSkills: (query: string, category?: string, sort?: string) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<string | undefined>;
  updateSkill: (slug: string, latestVersion?: string) => Promise<string | undefined>;
  uninstallSkill: (slug: string) => Promise<void>;
  checkInstalledSkillUpdates: (
    installedSkills: Array<{ skill_id: number | string; current_version: string; skill_name?: string }>,
  ) => Promise<Record<string, SkillUpdateInfo>>;
  clearSkillUpdates: () => void;
  enableSkill: (skillId: string) => Promise<void>;
  disableSkill: (skillId: string) => Promise<void>;
  setSkills: (skills: Skill[]) => void;
  updateSkill: (skillId: string, updates: Partial<Skill>) => void;
}

let _errorTimeout: ReturnType<typeof setTimeout> | null = null;

function clearErrorTimeout(): void {
  if (_errorTimeout) {
    clearTimeout(_errorTimeout);
    _errorTimeout = null;
  }
}

export const useSkillsStore = create<SkillsState>((set, get) => ({
  skills: [],
  searchResults: [],
  companyInstallMap: {},
  companyInstallEntries: {},
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  checkingUpdates: false,
  skillUpdates: {},
  error: null,

  clearError: () => {
    clearErrorTimeout();
    set({ error: null });
  },

  fetchSkills: async () => {
    set({ loading: true, error: null });
    try {
      // Fetch all skill sources in parallel to reduce first-load latency.
      // 关键：使用 allSettled，让任意一个数据源（gateway / hostApi / configs）
      // 在冷启动竞态、CLI 抖动或权限问题下失败时，不会连累其他数据源，
      // 也不会让整个 fetchSkills 走 catch 块导致列表完全不更新。
      const gatewayDataPromise = useGatewayStore.getState().rpc<GatewaySkillsStatusResult>(
        'skills.status',
        undefined,
        SKILLS_GATEWAY_RPC_TIMEOUT_MS,
      );
      const clawhubResultPromise = hostApiFetch<{ success: boolean; results?: ClawHubListResult[]; error?: string }>('/api/clawhub/list');
      const configResultPromise = hostApiFetch<Record<string, { apiKey?: string; env?: Record<string, string> }>>('/api/skills/configs');
      const marketplaceResultPromise = hostApiFetch<{ success: boolean; results?: MarketplaceSkill[]; error?: string }>(
        '/api/clawhub/search',
        {
          method: 'POST',
          body: JSON.stringify({ query: '', category: '', sort: '-download_count' }),
        },
      );
      const companyInstallMapPromise = hostApiFetch<{
        success: boolean;
        installs?: Record<string, string>;
        entries?: Record<string, CompanyInstallEntry>;
      }>('/api/clawhub/company-install-map');
      const [gatewaySettled, clawhubSettled, configSettled, marketplaceSettled, companyInstallMapSettled] = await Promise.allSettled([
        gatewayDataPromise,
        clawhubResultPromise,
        configResultPromise,
        marketplaceResultPromise,
        companyInstallMapPromise,
      ]);

      const gatewayData: GatewaySkillsStatusResult = gatewaySettled.status === 'fulfilled'
        ? gatewaySettled.value
        : { skills: undefined };
      let clawhubResult: { success: boolean; results?: ClawHubListResult[]; error?: string } = clawhubSettled.status === 'fulfilled'
        ? clawhubSettled.value
        : { success: false, results: [] };
      const configResult: Record<string, { apiKey?: string; env?: Record<string, string> }> = configSettled.status === 'fulfilled'
        ? configSettled.value
        : {};

      if (gatewaySettled.status === 'rejected') {
        console.warn('[Skills Store] gateway skills.status RPC failed (non-fatal):', gatewaySettled.reason);
      }
      if (clawhubSettled.status === 'rejected') {
        console.warn('[Skills Store] /api/clawhub/list failed (non-fatal):', clawhubSettled.reason);
      }
      if (configSettled.status === 'rejected') {
        console.warn('[Skills Store] /api/skills/configs failed (non-fatal):', configSettled.reason);
      }
      if (marketplaceSettled.status === 'rejected') {
        console.warn('[Skills Store] /api/clawhub/search failed (non-fatal):', marketplaceSettled.reason);
      }
      if (companyInstallMapSettled.status === 'rejected') {
        console.warn('[Skills Store] /api/clawhub/company-install-map failed (non-fatal):', companyInstallMapSettled.reason);
      }

      let companyInstallMap = get().companyInstallMap;
      let companyInstallEntries = get().companyInstallEntries;
      if (companyInstallMapSettled.status === 'fulfilled' && companyInstallMapSettled.value.success) {
        companyInstallMap = companyInstallMapSettled.value.installs ?? {};
        companyInstallEntries = companyInstallMapSettled.value.entries ?? {};
      }

      let marketplaceResults: MarketplaceSkill[] = [];
      if (marketplaceSettled.status === 'fulfilled' && marketplaceSettled.value.success) {
        marketplaceResults = marketplaceSettled.value.results ?? [];
      }

      // 兜底通道：当 hostApi 通道失败或者返回了空列表（冷启动竞态、HTTP server
      // 还没起来、CLI 抖动等），直接通过 IPC 走 main 进程的 listInstalled，
      // 这条路径绕开了 host API 的 HTTP server，是最可靠的兜底。
      const clawhubHasResults = clawhubResult.success && (clawhubResult.results?.length ?? 0) > 0;
      if (!clawhubHasResults) {
        try {
          const ipcResp = await invokeIpc<{ success: boolean; results?: ClawHubListResult[]; error?: string }>('clawhub:list');
          const ipcResults = ipcResp?.results;
          if (ipcResp?.success && Array.isArray(ipcResults) && ipcResults.length > 0) {
            console.log('[Skills Store] Recovered ClawHub list via IPC fallback, count:', ipcResults.length);
            clawhubResult = { success: true, results: ipcResults };
          } else if (ipcResp && !ipcResp.success) {
            console.warn('[Skills Store] clawhub:list IPC fallback returned error:', ipcResp.error);
          }
        } catch (ipcErr) {
          console.warn('[Skills Store] clawhub:list IPC fallback failed (non-fatal):', ipcErr);
        }
      }

      let combinedSkills: Skill[] = [];
      const currentSkills = get().skills;
      const configLookup = buildSkillConfigLookup(configResult);

      // 预先建立 ClawHub list 结果索引，作为权威的"本机真实路径"来源。
      // 这样即使 Gateway 报告的 baseDir 已经失效（用户名变更、配置目录搬家、
      // 旧 lock.json 残留、OneDrive 重定向等），只要 ClawHub list 仍能扫描到
      // 该 slug，就能用真实路径替换 Gateway 报告的"幽灵路径"，避免技能从
      // 列表中消失。
      const clawhubBySlug = new Map<string, ClawHubListResult>();
      if (clawhubResult.success && clawhubResult.results) {
        for (const cs of clawhubResult.results) {
          if (cs.slug) clawhubBySlug.set(cs.slug, cs);
        }
      }

      // Renderer 无法安全访问 Node fs；路径存在性由 main 的 clawhub list 负责。
      const tryExistsSync = (_p: string | undefined): boolean | null => null;

      // Map gateway skills info
      if (gatewayData.skills) {
        combinedSkills = gatewayData.skills
          .filter((s: GatewaySkillStatus) => {
            // 内置技能仍然只保留白名单内的项
            if (s.bundled && !ALLOWED_BUILTIN_SKILLS.has(s.skillKey)) {
              return false;
            }
            return true;
          })
          .map((s: GatewaySkillStatus) => {
            const slug = s.slug || s.skillKey;
            const directConfig = resolveDirectSkillConfig([s.skillKey, slug, s.name], configLookup) || {};

            // 解析 baseDir：优先使用 Gateway 报告的真实存在路径；
            // 若 Gateway 路径不存在，用 ClawHub list 扫描结果中的真实路径覆盖；
            // 都不可用时标记 pathMissing，但保留技能。
            const clawhubMatch = clawhubBySlug.get(slug);
            const gatewayExists = tryExistsSync(s.baseDir);
            const clawhubExists = tryExistsSync(clawhubMatch?.baseDir);
            let resolvedBaseDir = s.baseDir;
            let pathMissing = false;
            if (!s.bundled) {
              if (gatewayExists === false && clawhubExists === true && clawhubMatch?.baseDir) {
                resolvedBaseDir = clawhubMatch.baseDir;
              } else if (gatewayExists === false && clawhubExists !== true) {
                pathMissing = true;
              }
            }

            const version = s.version || 'unknown';

            return {
              id: s.skillKey,
              slug,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: typeof directConfig.enabled === 'boolean' ? directConfig.enabled : !s.disabled,
              icon: s.emoji || '📦',
              version,
              author: s.author,
              config: {
                ...(s.config || {}),
                ...directConfig,
              },
              isCore: s.bundled && s.always,
              isBundled: s.bundled,
              source: s.source,
              baseDir: resolvedBaseDir,
              filePath: s.filePath,
              pathMissing,
            };
          });
      } else if (currentSkills.length > 0) {
        // ... if gateway down ...
        combinedSkills = [...currentSkills];
      }

      // Merge with ClawHub results
      if (clawhubResult.success && clawhubResult.results) {
        clawhubResult.results.forEach((cs: ClawHubListResult) => {
          const existing = findExistingInstalledSkill(combinedSkills, {
            id: cs.slug,
            slug: cs.slug,
            name: cs.name,
            baseDir: cs.baseDir,
          });
          const clawhubExists = tryExistsSync(cs.baseDir);
          if (existing) {
            // 如果当前 baseDir 缺失或在本机不存在，且 ClawHub 给了一个真实存在的路径，
            // 用后者覆盖，并清除 pathMissing 标记。
            const existingExists = tryExistsSync(existing.baseDir);
            if (cs.baseDir && clawhubExists === true && existingExists !== true) {
              existing.baseDir = cs.baseDir;
              existing.pathMissing = false;
            } else if (!existing.baseDir && cs.baseDir) {
              existing.baseDir = cs.baseDir;
              if (clawhubExists !== false) existing.pathMissing = false;
            }
            applyClawHubMetadata(existing, cs);
            return;
          }
          if (clawhubExists === false) {
            return;
          }
          const directConfig = resolveDirectSkillConfig([cs.slug, cs.name], configLookup) || {};
          combinedSkills.push({
            id: cs.slug,
            slug: cs.slug,
            name: cs.name || cs.slug,
            description: cs.description || '',
            enabled: typeof directConfig.enabled === 'boolean' ? directConfig.enabled : false,
            icon: '⌛',
            version: cs.version && cs.version.toLowerCase() !== 'unknown' ? cs.version : 'unknown',
            author: cs.author,
            config: directConfig,
            isCore: false,
            isBundled: false,
            source: cs.source || 'openclaw-managed',
            baseDir: cs.baseDir,
            pathMissing: false,
          });
        });
      }

      if (clawhubResult.success && Array.isArray(clawhubResult.results)) {
        const diskSkills = clawhubResult.results.map((cs) => ({
          id: cs.slug,
          slug: cs.slug,
          name: cs.name,
          baseDir: cs.baseDir,
        }));
        combinedSkills = combinedSkills.filter((skill) => isSkillPresentOnDisk(skill, diskSkills));
      }

      combinedSkills = dedupeInstalledSkills(combinedSkills).filter(shouldIncludeInMySkills);
      const marketplaceMetadata = [
        ...marketplaceResults,
        ...companyInstallEntriesToMarketplaceSkills(companyInstallEntries),
      ];
      if (marketplaceMetadata.length > 0) {
        combinedSkills = enrichSkillsWithMarketplaceMetadata(combinedSkills, marketplaceMetadata).filter(
          shouldIncludeInMySkills,
        );
      }

      set({
        skills: combinedSkills,
        companyInstallMap,
        companyInstallEntries,
        loading: false,
      });
    } catch (error) {
      console.error('Failed to fetch skills:', error);
      const appError = normalizeAppError(error, { module: 'skills', operation: 'fetch' });
      // Preserve previous skills on error (stale-while-revalidate).
      const errorKey = mapErrorCodeToSkillErrorKey(appError.code, 'fetch');
      set((prev) => ({ loading: false, error: errorKey, skills: prev.skills }));
      // Auto-clear error after 3 seconds
      clearErrorTimeout();
      _errorTimeout = setTimeout(() => {
        set({ error: null });
        _errorTimeout = null;
      }, 3000);
    }
  },

  searchSkills: async (query: string, category = '', sort = '') => {
    set({ searching: true, searchError: null });
    try {
      const requestBody = { query, category, sort };
      console.log('[Skills Store] Request URL: /api/clawhub/search, Method: POST, Body:', requestBody);
      const result = await hostApiFetch<{ success: boolean; results?: MarketplaceSkill[]; error?: string }>('/api/clawhub/search', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });
      if (result.success) {
        console.log('[Skills Store] Search results:', result.results);
        console.log('[Skills Store] First 5 results:', result.results?.slice(0, 5));
        set({ searchResults: result.results || [] });
      } else {
        throw normalizeAppError(new Error(result.error || 'Search failed'), {
          module: 'skills',
          operation: 'search',
        });
      }
    } catch (error) {
      const appError = normalizeAppError(error, { module: 'skills', operation: 'search' });
      set({ searchError: mapErrorCodeToSkillErrorKey(appError.code, 'search') });
    } finally {
      set({ searching: false });
    }
  },

  installSkill: async (slug: string, version?: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{
        success: boolean;
        error?: string;
        slug?: string;
        baseDir?: string;
        source?: string;
      }>('/api/clawhub/install', {
        method: 'POST',
        body: JSON.stringify({ slug, version }),
      });
      if (!result.success) {
        const errorMessage = result.error || 'Install failed';
        console.error('[SkillsStore] Install failed with error:', errorMessage);
        throw new Error(errorMessage);
      }

      const packageSlug = result.slug?.trim()
        || result.baseDir?.split(/[/\\]/).filter(Boolean).pop()
        || slug;
      void reportSkillDownload(packageSlug, 1);

      const installedSkill = get().searchResults.find((s) => s.slug === slug);
      const newSkill: Skill = mergeSkillWithMarketplaceMetadata({
        id: packageSlug,
        slug: packageSlug,
        name: installedSkill?.name || packageSlug,
        description: installedSkill?.description || '',
        enabled: true,
        icon: '📦',
        version: version || installedSkill?.version || 'unknown',
        author: installedSkill?.author,
        config: {},
        isCore: false,
        isBundled: false,
        source: result.source || 'openclaw-managed',
        baseDir: result.baseDir,
        filePath: undefined,
        downloads: installedSkill?.downloads,
      }, installedSkill);

      set((state) => {
        const existingIndex = state.skills.findIndex((s) => s.id === packageSlug || s.slug === packageSlug);
        const nextInstallMap = { ...state.companyInstallMap };
        const nextInstallEntries = { ...state.companyInstallEntries };
        const marketplaceId = installedSkill?.id != null
          ? String(installedSkill.id)
          : (/^\d+$/.test(slug) ? slug : undefined);
        if (marketplaceId) {
          nextInstallMap[marketplaceId] = packageSlug;
          nextInstallEntries[marketplaceId] = {
            packageSlug,
            name: installedSkill?.name || packageSlug,
            version: installedSkill?.version || version || 'unknown',
            author: installedSkill?.author,
            description: installedSkill?.description,
          };
        }

        if (existingIndex >= 0) {
          const newSkills = [...state.skills];
          newSkills[existingIndex] = { ...newSkills[existingIndex], ...newSkill };
          return {
            skills: newSkills,
            companyInstallMap: nextInstallMap,
            companyInstallEntries: nextInstallEntries,
          };
        }

        return {
          skills: [...state.skills, newSkill],
          companyInstallMap: nextInstallMap,
          companyInstallEntries: nextInstallEntries,
        };
      });

      return packageSlug;
    } catch (error) {
      console.error('Install error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  uninstallSkill: async (slug: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/uninstall', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Uninstall failed');
      }

      set((state) => {
        const nextInstallMap = { ...state.companyInstallMap };
        const nextInstallEntries = { ...state.companyInstallEntries };
        const nextSkillUpdates = { ...state.skillUpdates };
        const removeIds = new Set<string>();
        let packageSlug: string | undefined;

        if (/^\d+$/.test(slug)) {
          removeIds.add(slug);
          packageSlug = nextInstallMap[slug];
          delete nextInstallMap[slug];
          delete nextInstallEntries[slug];
          delete nextSkillUpdates[slug];
        } else {
          packageSlug = slug;
          for (const [marketplaceId, mappedSlug] of Object.entries(nextInstallMap)) {
            if (mappedSlug === slug || marketplaceId === slug) {
              removeIds.add(marketplaceId);
              delete nextInstallMap[marketplaceId];
              delete nextInstallEntries[marketplaceId];
              delete nextSkillUpdates[marketplaceId];
            }
          }
        }

        const slugsToRemove = new Set(
          [slug, packageSlug].filter((value): value is string => Boolean(value?.trim())),
        );
        const nextSkills = state.skills.filter((skill) => {
          if (skill.slug && slugsToRemove.has(skill.slug)) return false;
          if (slugsToRemove.has(skill.id)) return false;
          return true;
        });
        const nextSearchResults = state.searchResults.map((skill) => {
          const marketplaceId = skill.id != null ? String(skill.id) : '';
          if (removeIds.has(marketplaceId) || skill.slug === slug || String(skill.id) === slug) {
            return { ...skill, __installed: false };
          }
          return skill;
        });

        return {
          skills: nextSkills,
          searchResults: nextSearchResults,
          companyInstallMap: nextInstallMap,
          companyInstallEntries: nextInstallEntries,
          skillUpdates: nextSkillUpdates,
        };
      });
    } catch (error) {
      console.error('Uninstall error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  updateSkill: async (slug: string, latestVersion?: string) => {
    set((state) => ({ installing: { ...state.installing, [slug]: true } }));
    try {
      const result = await hostApiFetch<{
        success: boolean;
        error?: string;
        slug?: string;
        baseDir?: string;
        source?: string;
        version?: string;
        name?: string;
        author?: string;
        description?: string;
        marketplaceId?: number | string;
      }>('/api/clawhub/update', {
        method: 'POST',
        body: JSON.stringify({ slug }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Update failed');
      }

      const packageSlug = result.slug?.trim()
        || result.baseDir?.split(/[/\\]/).filter(Boolean).pop()
        || slug;
      const marketplaceSkill = get().searchResults.find((s) => s.slug === slug || String(s.id) === slug);
      const marketplaceId = result.marketplaceId != null
        ? String(result.marketplaceId)
        : marketplaceSkill?.id != null
          ? String(marketplaceSkill.id)
          : (/^\d+$/.test(slug) ? slug : undefined);
      const resolvedName = result.name?.trim() || marketplaceSkill?.name || packageSlug;
      const resolvedVersion = latestVersion?.trim()
        || result.version?.trim()
        || marketplaceSkill?.version
        || 'unknown';
      const resolvedDescription = result.description?.trim() || marketplaceSkill?.description || '';
      const resolvedAuthor = result.author?.trim() || marketplaceSkill?.author;
      const refreshedMarketplaceSkill: MarketplaceSkill | undefined = marketplaceSkill
        ? {
            ...marketplaceSkill,
            name: resolvedName,
            version: resolvedVersion,
            description: resolvedDescription || marketplaceSkill.description,
            author: resolvedAuthor ?? marketplaceSkill.author,
          }
        : undefined;

      const newSkill: Skill = mergeSkillWithMarketplaceMetadata({
        id: packageSlug,
        slug: packageSlug,
        name: resolvedName,
        description: resolvedDescription,
        enabled: true,
        icon: '📦',
        version: resolvedVersion,
        author: resolvedAuthor,
        config: {},
        isCore: false,
        isBundled: false,
        source: result.source || 'openclaw-managed',
        baseDir: result.baseDir,
        downloads: marketplaceSkill?.downloads,
      }, refreshedMarketplaceSkill);

      set((state) => {
        const existingIndex = state.skills.findIndex((s) => s.id === packageSlug || s.slug === packageSlug);
        const nextInstallMap = { ...state.companyInstallMap };
        const nextInstallEntries = { ...state.companyInstallEntries };
        const nextSkillUpdates = { ...state.skillUpdates };
        if (marketplaceId) {
          nextInstallMap[marketplaceId] = packageSlug;
          nextInstallEntries[marketplaceId] = {
            packageSlug,
            name: resolvedName,
            version: resolvedVersion,
            author: resolvedAuthor,
            description: resolvedDescription,
          };
          delete nextSkillUpdates[marketplaceId];
        }

        const nextSkills = existingIndex >= 0
          ? state.skills.map((skill, index) => (index === existingIndex ? { ...skill, ...newSkill } : skill))
          : [...state.skills, newSkill];

        const matchesMarketplaceKey = (skill: MarketplaceSkill) => (
          skill.slug === slug
          || String(skill.id) === slug
          || (marketplaceId != null && String(skill.id) === marketplaceId)
        );
        const nextSearchResults = state.searchResults.map((skill) => {
          if (!matchesMarketplaceKey(skill)) return skill;
          return {
            ...skill,
            name: resolvedName,
            version: resolvedVersion,
            description: resolvedDescription || skill.description,
            author: resolvedAuthor ?? skill.author,
          };
        });

        return {
          skills: nextSkills,
          searchResults: nextSearchResults,
          companyInstallMap: nextInstallMap,
          companyInstallEntries: nextInstallEntries,
          skillUpdates: nextSkillUpdates,
        };
      });

      return packageSlug;
    } catch (error) {
      console.error('Update error:', error);
      throw error;
    } finally {
      set((state) => {
        const newInstalling = { ...state.installing };
        delete newInstalling[slug];
        return { installing: newInstalling };
      });
    }
  },

  checkInstalledSkillUpdates: async (installedSkills) => {
    set({ checkingUpdates: true });
    try {
      console.log('[Skills Store] check-updates request:', installedSkills);
      const result = await hostApiFetch<{
        success: boolean;
        error?: string;
        results?: Array<{
          skill_id: number;
          skill_name?: string;
          current_version: string;
          has_update: boolean;
          latest_version?: string;
          error?: string;
        }>;
      }>('/api/clawhub/check-updates', {
        method: 'POST',
        body: JSON.stringify({ skills: installedSkills }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Check updates failed');
      }
      console.log('[Skills Store] check-updates response:', result.results);
      for (const item of result.results || []) {
        const label = item.skill_name?.trim() || `skill_id=${item.skill_id}`;
        if (item.error) {
          console.log(`[Skills Store] // ${label}: 检测失败 — ${item.error}`);
        } else if (item.has_update) {
          console.log(
            `[Skills Store] // ${label}: 当前 v${item.current_version} → 最新 v${item.latest_version ?? '?'}（有更新）`,
          );
        } else {
          console.log(`[Skills Store] // ${label}: 当前 v${item.current_version}（已是最新）`);
        }
      }

      const skillUpdates: Record<string, SkillUpdateInfo> = {};
      for (const item of result.results || []) {
        const key = String(item.skill_id);
        skillUpdates[key] = {
          hasUpdate: Boolean(item.has_update),
          latestVersion: item.latest_version,
          skillName: item.skill_name,
          error: item.error,
        };
      }
      set({ skillUpdates });
      return skillUpdates;
    } catch (error) {
      console.error('Check updates error:', error);
      throw error;
    } finally {
      set({ checkingUpdates: false });
    }
  },

  clearSkillUpdates: () => set({ skillUpdates: {} }),

  enableSkill: async (skillId) => {
    const { updateSkill, skills } = get();
    const skill = skills.find((item) => item.id === skillId);

    try {
      const result = await hostApiFetch<{ success: boolean; skillKey?: string; error?: string }>('/api/skills/enabled', {
        method: 'PUT',
        body: JSON.stringify({
          skillKey: skillId,
          slug: skill?.slug,
          name: skill?.name,
          enabled: true,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to enable skill');
      }
      updateSkill(skillId, { enabled: true });
    } catch (error) {
      console.error('Failed to enable skill:', error);
      throw error;
    }
  },

  disableSkill: async (skillId) => {
    const { updateSkill, skills } = get();

    const skill = skills.find((s) => s.id === skillId);
    if (skill?.isCore) {
      throw new Error('Cannot disable core skill');
    }

    try {
      const result = await hostApiFetch<{ success: boolean; skillKey?: string; error?: string }>('/api/skills/enabled', {
        method: 'PUT',
        body: JSON.stringify({
          skillKey: skillId,
          slug: skill?.slug,
          name: skill?.name,
          enabled: false,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to disable skill');
      }
      updateSkill(skillId, { enabled: false });
    } catch (error) {
      console.error('Failed to disable skill:', error);
      throw error;
    }
  },

  setSkills: (skills) => set({ skills }),

  updateSkill: (skillId, updates) => {
    set((state) => ({
      skills: state.skills.map((skill) =>
        skill.id === skillId ? { ...skill, ...updates } : skill
      ),
    }));
  },

  // 本地更新搜索结果，用于安装/卸载后的即时状态更新
  setSearchResults: (results) => set({ searchResults: results }),
}));
