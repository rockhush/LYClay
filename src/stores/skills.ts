/**
 * Skills State Store
 * Manages skill/plugin state
 */
import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import { AppError, normalizeAppError } from '@/lib/error-model';
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
  version?: string;
  source?: string;
  baseDir?: string;
};

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
      const gatewayDataPromise = useGatewayStore.getState().rpc<GatewaySkillsStatusResult>('skills.status');
      const clawhubResultPromise = hostApiFetch<{ success: boolean; results?: ClawHubListResult[]; error?: string }>('/api/clawhub/list');
      const configResultPromise = hostApiFetch<Record<string, { apiKey?: string; env?: Record<string, string> }>>('/api/skills/configs');
      const [gatewayData, clawhubResult, configResult] = await Promise.all([
        gatewayDataPromise,
        clawhubResultPromise,
        configResultPromise,
      ]);

      let combinedSkills: Skill[] = [];
      const currentSkills = get().skills;

      // Map gateway skills info
      if (gatewayData.skills) {
        combinedSkills = gatewayData.skills
          .filter((s: GatewaySkillStatus) => {
            // 只保留白名单中的内置技能
            if (s.bundled && !ALLOWED_BUILTIN_SKILLS.has(s.skillKey)) {
              return false;
            }
            // 对于非内置技能，检查目录是否存在
            if (!s.bundled && s.baseDir) {
              try {
                // 使用 fs.existsSync 检查目录是否存在
                const fs = require('fs');
                if (!fs.existsSync(s.baseDir)) {
                  console.log(`Skill ${s.skillKey} directory not found, skipping: ${s.baseDir}`);
                  return false;
                }
              } catch {
                // 如果检查失败，保留技能（可能是权限问题）
              }
            }
            return true;
          })
          .map((s: GatewaySkillStatus) => {
            // Merge with direct config if available
            const directConfig = configResult[s.skillKey] || {};

            // 获取版本号：优先使用 Gateway 返回的版本号，否则尝试从 package.json 读取
            let version = s.version || 'unknown';
            if (version === 'unknown' || !version) {
              try {
                const fs = require('fs');
                const path = require('path');
                if (s.baseDir) {
                  const pkgPath = path.join(s.baseDir, 'package.json');
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
              slug: s.slug || s.skillKey,
              name: s.name || s.skillKey,
              description: s.description || '',
              enabled: !s.disabled,
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
              baseDir: s.baseDir,
              filePath: s.filePath,
            };
          });
      } else if (currentSkills.length > 0) {
        // ... if gateway down ...
        combinedSkills = [...currentSkills];
      }

      // Merge with ClawHub results
      if (clawhubResult.success && clawhubResult.results) {
        clawhubResult.results.forEach((cs: ClawHubListResult) => {
          const existing = combinedSkills.find(s => s.id === cs.slug);
          if (existing) {
            if (!existing.baseDir && cs.baseDir) {
              existing.baseDir = cs.baseDir;
            }
            if (!existing.source && cs.source) {
              existing.source = cs.source;
            }
            // 更新版本号，避免显示 'unknown'
            if (cs.version && (existing.version === 'unknown' || !existing.version)) {
              existing.version = cs.version;
            }
            return;
          }
          const directConfig = configResult[cs.slug] || {};
          combinedSkills.push({
            id: cs.slug,
            slug: cs.slug,
            name: cs.slug,
            description: 'Recently installed, initializing...',
            enabled: false,
            icon: '⌛',
            version: cs.version || 'unknown',
            author: undefined,
            config: directConfig,
            isCore: false,
            isBundled: false,
            source: cs.source || 'openclaw-managed',
            baseDir: cs.baseDir,
          });
        });
      }

      set({ skills: combinedSkills, loading: false });
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
      
      // 添加新安装的技能到状态中，确保即时显示
      const newSkill: Skill = {
        id: slug,
        slug: slug,
        name: slug,
        description: 'Recently installed, initializing...',
        enabled: true,  // 安装后默认启用
        icon: '📦',
        version: version || 'unknown',
        author: undefined,
        config: {},
        isCore: false,
        isBundled: false,
        source: result.source || 'openclaw-managed',
        baseDir: result.baseDir,
        filePath: undefined,
      };
      
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
    const { updateSkill } = get();

    try {
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: true });
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
      await useGatewayStore.getState().rpc('skills.update', { skillKey: skillId, enabled: false });
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
