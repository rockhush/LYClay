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
  isPlaceholderSkillDescription,
  mergeSkillWithMarketplaceMetadata,
  normalizeSkillLookupKey,
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
]);

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
  if (cs.name?.trim() && (!existing.name || existing.name === existing.slug || existing.name === existing.id)) {
    existing.name = cs.name.trim();
  }
  if (cs.description?.trim() && isPlaceholderSkillDescription(existing.description)) {
    existing.description = cs.description.trim();
  }
  if (cs.author?.trim() && !existing.author) {
    existing.author = cs.author.trim();
  }
  if (cs.version && cs.version.toLowerCase() !== 'unknown' && (!existing.version || existing.version.toLowerCase() === 'unknown')) {
    existing.version = cs.version;
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

interface SkillsState {
  skills: Skill[];
  searchResults: MarketplaceSkill[];
  loading: boolean;
  searching: boolean;
  searchError: string | null;
  installing: Record<string, boolean>; // slug -> boolean
  error: string | null;

  // Actions
  fetchSkills: () => Promise<void>;
  searchSkills: (query: string, category?: string, sort?: string) => Promise<void>;
  installSkill: (slug: string, version?: string) => Promise<void>;
  uninstallSkill: (slug: string) => Promise<void>;
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
  loading: false,
  searching: false,
  searchError: null,
  installing: {},
  error: null,

  clearError: () => {
    clearErrorTimeout();
    set({ error: null });
  },

  fetchSkills: async () => {
    // Only show loading state if we have no skills yet (initial load)
    if (get().skills.length === 0) {
      set({ loading: true, error: null });
    }
    try {
      // Fetch all skill sources in parallel to reduce first-load latency.
      // 关键：使用 allSettled，让任意一个数据源（gateway / hostApi / configs）
      // 在冷启动竞态、CLI 抖动或权限问题下失败时，不会连累其他数据源，
      // 也不会让整个 fetchSkills 走 catch 块导致列表完全不更新。
      const gatewayDataPromise = useGatewayStore.getState().rpc<GatewaySkillsStatusResult>('skills.status');
      const clawhubResultPromise = hostApiFetch<{ success: boolean; results?: ClawHubListResult[]; error?: string }>('/api/clawhub/list');
      const configResultPromise = hostApiFetch<Record<string, { apiKey?: string; env?: Record<string, string> }>>('/api/skills/configs');
      const marketplaceResultPromise = hostApiFetch<{ success: boolean; results?: MarketplaceSkill[]; error?: string }>('/api/clawhub/search', {
        method: 'POST',
        body: JSON.stringify({ query: '', category: '', sort: '-download_count' }),
      });
      const [gatewaySettled, clawhubSettled, configSettled, marketplaceSettled] = await Promise.allSettled([
        gatewayDataPromise,
        clawhubResultPromise,
        configResultPromise,
        marketplaceResultPromise,
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
      const marketplaceResults: MarketplaceSkill[] = marketplaceSettled.status === 'fulfilled' && marketplaceSettled.value.success
        ? (marketplaceSettled.value.results ?? [])
        : [];

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

      // 仅当 renderer 端能拿到 fs 模块时才做存在性探测；任何形式的失败
      // （context isolation 关闭 require、沙箱、权限）都返回 null（"未知"），
      // 由调用方按"未知则保留"处理，避免再因环境差异误杀整列技能。
      const tryExistsSync = (p: string | undefined): boolean | null => {
        if (!p) return null;
        try {
          const fs = require('fs');
          return Boolean(fs.existsSync(p));
        } catch {
          return null;
        }
      };

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
            // Merge with direct config if available
            const directConfig = resolveDirectSkillConfig([s.skillKey, slug, s.name], configLookup) || {};

            // 解析 baseDir：优先使用 Gateway 报告的真实存在路径；
            // 若 Gateway 路径不存在，用 ClawHub list 扫描结果中的真实路径覆盖；
            // 都不可用时标记 pathMissing，但保留技能。
            const slug = s.slug || s.skillKey;
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

            // 获取版本号：优先使用 Gateway 返回的版本号，否则尝试从 package.json 读取
            let version = s.version || 'unknown';
            if (version === 'unknown' || !version) {
              try {
                const fs = require('fs');
                const path = require('path');
                if (resolvedBaseDir) {
                  const pkgPath = path.join(resolvedBaseDir, 'package.json');
                  if (fs.existsSync(pkgPath)) {
                    const pkgContent = fs.readFileSync(pkgPath, 'utf-8');
                    const pkg = JSON.parse(pkgContent);
                    if (pkg.version) {
                      version = pkg.version;
                    }
                  }
                }
              } catch (err) {
                // 忽略读取错误
                console.log(`Failed to read package.json for skill ${s.skillKey}:`, err);
              }
            }
            // 如果还是未知，使用默认版本号
            if (version === 'unknown' || !version) {
              version = '1.0.0';
            }

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
          const existing = combinedSkills.find(s => s.id === cs.slug || s.slug === cs.slug);
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
          const directConfig = resolveDirectSkillConfig([cs.slug, cs.name], configLookup) || {};
          combinedSkills.push({
            id: cs.slug,
            slug: cs.slug,
            name: cs.name || cs.slug,
            description: cs.description || '',
            enabled: typeof directConfig.enabled === 'boolean' ? directConfig.enabled : false,
            icon: '⌛',
            version: cs.version && cs.version.toLowerCase() !== 'unknown' ? cs.version : '1.0.0',
            author: cs.author,
            config: directConfig,
            isCore: false,
            isBundled: false,
            source: cs.source || 'openclaw-managed',
            baseDir: cs.baseDir,
            pathMissing: clawhubExists === false,
          });
        });
      }

      // 最后兜底：如果上一次状态里存在的"非内置"技能在本次新数据中丢失了
      // （后端某次 RPC 抖动、CLI 偶发挂死等），不要让它从 UI 中凭空消失。
      // 保留下来并打 pathMissing 标记，让用户能看到、能选择卸载或重装。
      if (currentSkills.length > 0) {
        const seen = new Set(combinedSkills.map(s => s.id));
        const seenSlugs = new Set(combinedSkills.map(s => s.slug).filter(Boolean));
        for (const prev of currentSkills) {
          if (prev.isBundled || prev.isCore) continue;
          if (seen.has(prev.id)) continue;
          if (prev.slug && seenSlugs.has(prev.slug)) continue;
          combinedSkills.push({ ...prev, pathMissing: true });
        }
      }

      combinedSkills = enrichSkillsWithMarketplaceMetadata(combinedSkills, marketplaceResults);

      set({
        skills: combinedSkills,
        loading: false,
        ...(marketplaceResults.length > 0 ? { searchResults: marketplaceResults } : {}),
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
      const result = await hostApiFetch<{ success: boolean; error?: string; baseDir?: string; source?: string }>('/api/clawhub/install', {
        method: 'POST',
        body: JSON.stringify({ slug, version }),
      });
      if (!result.success) {
        // 保留原始错误消息，不要转换为通用错误代码
        const errorMessage = result.error || 'Install failed';
        console.error('[SkillsStore] Install failed with error:', errorMessage);
        throw new Error(errorMessage);
      }

      // Queue a skill-download record for the management/claw/report uploader.
      // Fire-and-forget — the reporter swallows its own errors so install UX
      // is never blocked by a stats hiccup.
      void reportSkillDownload(slug, 1);

      // 添加新安装的技能到状态中，确保即时显示
      const installedSkill = get().searchResults.find((s) => s.slug === slug);
      const newSkill: Skill = mergeSkillWithMarketplaceMetadata({
        id: slug,
        slug,
        name: installedSkill?.name || slug,
        description: installedSkill?.description || '',
        enabled: true,
        icon: '📦',
        version: version || installedSkill?.version || '1.0.0',
        author: installedSkill?.author,
        config: {},
        isCore: false,
        isBundled: false,
        source: result.source || 'openclaw-managed',
        baseDir: result.baseDir,
        filePath: undefined,
        downloads: installedSkill?.downloads,
      }, installedSkill);
      
      // 更新状态，添加新技能
      set((state) => {
        const existingIndex = state.skills.findIndex(s => s.id === slug);
        if (existingIndex >= 0) {
          // 更新现有技能
          const newSkills = [...state.skills];
          newSkills[existingIndex] = { ...newSkills[existingIndex], ...newSkill };
          return { skills: newSkills };
        } else {
          // 添加新技能
          return { skills: [...state.skills, newSkill] };
        }
      });
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
