import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search,
  Lock,
  Package,
  X,
  RefreshCw,
  Download,
  Trash2,
  Loader2,
  User as UserIcon,
  AlertCircle,
  MessageSquare,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
// import { Switch } from '@/components/ui/switch'; // 暂时隐藏「我的岗位助理」启用开关
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LoaderBadge, LoadingSpinner } from '@/components/common/LoadingSpinner';
import { cn } from '@/lib/utils';
import { hostApiFetch } from '@/lib/host-api';
import {
  commitCachedDigitalEmployeeDisplayMetadata,
  resolveCachedDigitalEmployeeDisplayMetadata,
  seedCachedDigitalEmployeeDisplayMetadata,
} from '@/lib/digital-employee-display-cache';
import { scheduleUiStateSync } from '@/lib/ui-state-persistence';
import { useChatStore } from '@/stores/chat';
import { useDigitalEmployeesStore } from '@/stores/digital-employees';
import {
  groupInstalledEmployeesByMarketId,
  mapInstalledEmployeeToMyAgent,
  shouldIncludeInMyDigitalEmployees,
} from './installed-employee-utils';
import {
  MARKETPLACE_CATEGORY_OPTIONS,
  type MyAgent,
  type MarketplaceAgent,
} from './mock-data';

const AGENT_COLOR = 'bg-[#FF922B]';
const MARKETPLACE_SEARCH_ERROR_MESSAGE = '岗位助理广场搜索失败，请使用公司内网连接';
const MAX_TAG_COUNT = 3;
const MAX_TAG_CHARS = 5;

function formatTagLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= MAX_TAG_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TAG_CHARS)}...`;
}

function AgentTagRow({ tags }: { tags: string[] }) {
  const visibleTags = tags.slice(0, MAX_TAG_COUNT);

  return (
    <div className="mt-2 flex h-[26px] min-h-[26px] items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {visibleTags.map((tag) => {
        const displayLabel = formatTagLabel(tag);
        return (
          <Tooltip key={tag}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex max-w-[5.5rem] shrink-0 items-center rounded-full bg-[#FFF2E5] px-2.5 py-1 text-[11px] font-normal leading-none text-[#FF922B] dark:bg-[#FF922B]/15"
              >
                {displayLabel}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" className="text-[12px]">
              {tag}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

function AgentDescriptionRow({ description }: { description: string }) {
  const displayText = description.trim() || '—';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <p className="mt-3 h-[3.1em] min-h-[3.1em] text-[12.5px] text-muted-foreground leading-[1.55] line-clamp-2 break-words">
          {displayText}
        </p>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-xs max-h-60 overflow-y-auto overflow-x-hidden whitespace-normal break-words pr-1 text-[12.5px] leading-relaxed"
      >
        {displayText}
      </TooltipContent>
    </Tooltip>
  );
}

function getAgentInitial(name: string): string {
  if (!name) return '数';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : '数';
}

function formatVersion(version: string): string {
  const trimmed = version.trim();
  if (!trimmed) return '未知';
  return trimmed.startsWith('v') ? trimmed : `v${trimmed}`;
}

function formatCreateTime(time: string): string {
  if (!time) return '';
  try {
    const date = new Date(time);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  } catch {
    return '';
  }
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAlreadyLatestUpdateError(error: unknown): boolean {
  return /Update version .+ must be newer than installed version .+/i.test(getErrorMessage(error));
}

interface AgentCardProps {
  agent: MyAgent;
  onToggle: (enabled: boolean) => void;
  onUninstall: () => void;
  onUse: () => void;
}

function AgentCard({ agent, onToggle: _onToggle, onUninstall, onUse }: AgentCardProps) {
  const initial = getAgentInitial(agent.name);
  const versionLabel = formatVersion(agent.version);
  const authorLabel = agent.author.trim() || '未知作者';

  return (
    <div
      className={cn(
        'group relative flex h-full flex-col text-left rounded-2xl border transition-colors p-4 overflow-hidden',
        'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04]',
        'hover:bg-[#FFF2E5]/70 hover:border-[#FF922B]/25 dark:hover:bg-white/[0.06]',
      )}
    >
      <div className="flex items-center gap-3 w-full">
        <div
          className={cn(
            'w-7 h-7 shrink-0 flex items-center justify-center text-[12px] font-semibold text-white rounded-lg overflow-hidden',
            AGENT_COLOR,
          )}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[14px] font-normal text-foreground truncate">
                {agent.name}
              </h3>
              {agent.isCore ? (
                <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 h-[16.5px]">
              <span className="shrink-0 text-[11px] leading-none text-muted-foreground/70">
                {versionLabel}
              </span>
              <span className="min-w-0 max-w-[55%] text-[11px] leading-none text-muted-foreground/70 truncate">
                {authorLabel}
              </span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              onUse();
            }}
            data-testid={`digital-employee-my-use-${agent.id}`}
            className={cn(
              'h-8 w-8 rounded-lg transition-colors shadow-none',
              'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
            )}
            title="使用"
          >
            <MessageSquare className="h-3.5 w-3.5" />
          </Button>
          {!agent.isCore && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={(event) => {
                event.stopPropagation();
                onUninstall();
              }}
              data-testid={`digital-employee-my-uninstall-${agent.id}`}
              className={cn(
                'h-8 w-8 rounded-lg transition-colors shadow-none',
                'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
              )}
              title="卸载"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {/*
          <Switch
            className="origin-right scale-[0.75]"
            checked={agent.enabled}
            onCheckedChange={onToggle}
            disabled={agent.isCore}
          />
          */}
        </div>
      </div>

      <AgentTagRow tags={agent.tags} />

      <AgentDescriptionRow description={agent.description} />
    </div>
  );
}

interface MarketplaceAgentCardProps {
  agent: MarketplaceAgent;
  isLoading?: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  onUpdate: () => void;
}

function MarketplaceAgentCard({
  agent,
  isLoading = false,
  onInstall,
  onUninstall,
  onUpdate,
}: MarketplaceAgentCardProps) {
  const initial = getAgentInitial(agent.name);
  const versionLabel = formatVersion(agent.version);
  const author = agent.author.trim() || '未知作者';
  const createTime = formatCreateTime(agent.updateTime);

  return (
    <div
      className={cn(
        'group relative flex h-full flex-col text-left rounded-2xl border transition-colors p-4 overflow-hidden',
        'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04]',
        'hover:bg-[#FFF2E5]/70 hover:border-[#FF922B]/25 dark:hover:bg-white/[0.06]',
      )}
    >
      <div className="flex items-center gap-3 w-full">
        <div
          className={cn(
            'w-7 h-7 shrink-0 flex items-center justify-center text-[12px] font-semibold text-white rounded-lg overflow-hidden',
            AGENT_COLOR,
          )}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[14px] font-normal text-foreground truncate">{agent.name}</h3>
            <span className="text-[11px] font-mono text-muted-foreground/70 shrink-0">
              {versionLabel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {agent.installed && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={onUpdate}
              disabled={isLoading}
              data-testid={`digital-employee-update-${agent.slug}`}
              className={cn(
                'h-8 w-8 rounded-lg transition-colors shadow-none',
                'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
              )}
              title="更新"
            >
              {isLoading ? (
                <LoadingSpinner size="sm" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={(event) => {
              event.stopPropagation();
              if (agent.installed) onUninstall();
              else onInstall();
            }}
            disabled={isLoading}
            data-testid={agent.installed
              ? `digital-employee-uninstall-${agent.slug}`
              : `digital-employee-install-${agent.slug}`}
            className={cn(
              'h-8 w-8 rounded-lg transition-colors shadow-none',
              'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
            )}
            title={agent.installed ? '卸载' : '安装'}
          >
            {isLoading ? (
              <LoadingSpinner size="sm" />
            ) : agent.installed ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <AgentTagRow tags={agent.tags} />

      <AgentDescriptionRow description={agent.description} />

      <div className="mt-3 flex h-[16px] min-h-[16px] items-center gap-4 text-[11.5px] text-muted-foreground">
        <span className="inline-flex min-w-0 max-w-[40%] items-center gap-1 truncate">
          <UserIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{author}</span>
        </span>

        <span className="inline-flex items-center gap-1" title="下载量">
          <Download className="h-3 w-3" />
          {agent.downloads}
        </span>

        <span className="inline-flex min-w-[5.5rem] items-center gap-1">
          {createTime ? (
            <>
              <RefreshCw className="h-3 w-3" />
              {createTime}
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export function DigitalEmployee() {
  const navigate = useNavigate();
  const newSession = useChatStore((state) => state.newSession);
  const [activeTab, setActiveTab] = useState<'mine' | 'market'>('mine');
  const [searchQuery, setSearchQuery] = useState('');
  const [marketQuery, setMarketQuery] = useState('');
  const [displayCacheRevision, setDisplayCacheRevision] = useState(0);
  const [marketAgents, setMarketAgents] = useState<MarketplaceAgent[]>([]);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketSearchError, setMarketSearchError] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [installFilter, setInstallFilter] = useState<'all' | 'installed' | 'uninstalled'>('all');
  const [sortBy, setSortBy] = useState<'download_count' | 'update_time'>('download_count');
  const [isUpdating, setIsUpdating] = useState(false);
  const {
    employees,
    marketplaceCatalog,
    loading: employeesLoading,
    marketplaceCatalogLoading,
    installingMarketEmployeeId,
    updatingInstanceId,
    fetchEmployees,
    prefetchMarketplaceCatalog,
    installMarketplaceEmployee,
    uninstallMarketplaceEmployee,
    updateEmployee,
    setEmployeeEnabled,
  } = useDigitalEmployeesStore();

  useEffect(() => {
    void fetchEmployees();
  }, [fetchEmployees]);

  useEffect(() => {
    void prefetchMarketplaceCatalog();
  }, [prefetchMarketplaceCatalog]);

  const fetchMarketAgents = useCallback(async () => {
    setMarketLoading(true);
    setMarketSearchError(false);
    try {
      const sort = `-${sortBy}`;
      const result = await hostApiFetch<{
        success: boolean;
        results?: MarketplaceAgent[];
        error?: string;
      }>('/api/digital-employee/marketplace/list', {
        method: 'POST',
        body: JSON.stringify({
          query: marketQuery.trim(),
          category: selectedCategory,
          sort,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || MARKETPLACE_SEARCH_ERROR_MESSAGE);
      }
      setMarketAgents(result.results || []);
    } catch {
      setMarketAgents([]);
      setMarketSearchError(true);
    } finally {
      setMarketLoading(false);
    }
  }, [marketQuery, selectedCategory, sortBy]);

  useEffect(() => {
    if (activeTab !== 'market') return;
    void fetchMarketAgents();
  }, [activeTab, fetchMarketAgents]);

  const installedEmployeesByMarketId = useMemo(
    () => groupInstalledEmployeesByMarketId(employees),
    [employees],
  );

  const marketplaceCatalogBySlug = useMemo(() => new Map(
    marketplaceCatalog.map((agent) => [agent.slug, agent as MarketplaceAgent]),
  ), [marketplaceCatalog]);

  const resolveCachedDisplay = useCallback((marketEmployeeId: string) => (
    resolveCachedDigitalEmployeeDisplayMetadata(marketEmployeeId)
  ), [displayCacheRevision]);

  useEffect(() => {
    let dirty = false;
    for (const employee of employees) {
      const marketplace = marketplaceCatalogBySlug.get(employee.marketEmployeeId);
      if (marketplace && seedCachedDigitalEmployeeDisplayMetadata(employee.marketEmployeeId, {
        version: marketplace.version,
        name: marketplace.name,
        author: marketplace.author,
        description: marketplace.description,
        updateTime: marketplace.updateTime,
        tags: marketplace.tags,
      })) {
        dirty = true;
      }
    }
    for (const agent of marketplaceCatalog) {
      if (seedCachedDigitalEmployeeDisplayMetadata(agent.slug, {
        version: agent.version,
        name: agent.name,
        author: agent.author,
        description: agent.description,
        updateTime: agent.updateTime,
        tags: agent.tags,
      })) {
        dirty = true;
      }
    }
    if (dirty) {
      setDisplayCacheRevision((value) => value + 1);
      scheduleUiStateSync();
    }
  }, [employees, marketplaceCatalog, marketplaceCatalogBySlug]);

  const myAgents = useMemo(() => employees
    .filter((employee) => {
      const cached = resolveCachedDisplay(employee.marketEmployeeId);
      return shouldIncludeInMyDigitalEmployees(
        employee,
        marketplaceCatalogBySlug,
        cached,
        { marketplaceCatalogLoading },
      );
    })
    .map((employee) => {
      const marketplace = marketplaceCatalogBySlug.get(employee.marketEmployeeId);
      const cached = resolveCachedDisplay(employee.marketEmployeeId);
      return mapInstalledEmployeeToMyAgent(employee, marketplace, cached);
    }), [employees, marketplaceCatalogBySlug, resolveCachedDisplay, marketplaceCatalogLoading]);

  const filteredMyAgents = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return myAgents
      .filter((agent) => {
        if (!q) return true;
        return (
          agent.name.toLowerCase().includes(q)
          || agent.description.toLowerCase().includes(q)
          || agent.author.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (a.isCore && !b.isCore) return -1;
        if (!a.isCore && b.isCore) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [myAgents, searchQuery]);

  const resolvedMarketAgents = useMemo(() => marketAgents.map((agent) => ({
    ...agent,
    installed: (installedEmployeesByMarketId.get(agent.slug)?.length ?? 0) > 0,
  })), [installedEmployeesByMarketId, marketAgents]);

  const installedMarketCount = resolvedMarketAgents.filter((agent) => agent.installed).length;
  const uninstalledMarketCount = resolvedMarketAgents.length - installedMarketCount;

  const filteredMarketAgents = useMemo(() => {
    return resolvedMarketAgents.filter((agent) => {
      if (installFilter === 'installed' && !agent.installed) return false;
      if (installFilter === 'uninstalled' && agent.installed) return false;
      return true;
    });
  }, [resolvedMarketAgents, installFilter]);

  const handleToggleAgent = useCallback(async (agentId: string, enabled: boolean) => {
    try {
      await setEmployeeEnabled(agentId, enabled);
      toast.success(enabled ? '已启用' : '已禁用');
    } catch (error) {
      toast.error(`状态更新失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [setEmployeeEnabled]);

  const refreshMyDigitalEmployees = useCallback(async () => {
    await Promise.all([
      fetchEmployees(),
      prefetchMarketplaceCatalog(),
    ]);
  }, [fetchEmployees, prefetchMarketplaceCatalog]);

  const handleInstallMarketAgent = useCallback(async (agent: MarketplaceAgent) => {
    setIsUpdating(true);
    try {
      await installMarketplaceEmployee({ marketEmployeeId: agent.slug });
      commitCachedDigitalEmployeeDisplayMetadata(agent.slug, {
        version: agent.version,
        name: agent.name,
        author: agent.author,
        description: agent.description,
        updateTime: agent.updateTime,
        tags: agent.tags,
      });
      setDisplayCacheRevision((value) => value + 1);
      scheduleUiStateSync();
      await prefetchMarketplaceCatalog();
      toast.success(`“${agent.name}”安装成功`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      toast.error(`安装失败：${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      setIsUpdating(false);
    }
  }, [installMarketplaceEmployee, prefetchMarketplaceCatalog]);

  const handleUninstallByMarketEmployeeId = useCallback(async (
    marketEmployeeId: string,
    displayName: string,
  ) => {
    try {
      await uninstallMarketplaceEmployee({ marketEmployeeId });
      await prefetchMarketplaceCatalog();
      toast.success(`“${displayName}”已卸载`);
    } catch (error) {
      toast.error(`卸载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [uninstallMarketplaceEmployee, prefetchMarketplaceCatalog]);

  const handleUninstallMarketAgent = useCallback(async (agent: MarketplaceAgent) => {
    await handleUninstallByMarketEmployeeId(agent.slug, agent.name);
  }, [handleUninstallByMarketEmployeeId]);

  const handleUseAgent = useCallback((agent: MyAgent) => {
    if (!agent.enabled) {
      toast.warning('请先启用该岗位助理');
      return;
    }
    newSession(agent.agentId);
    navigate('/');
  }, [navigate, newSession]);

  const handleUninstallMyAgent = useCallback(async (agent: MyAgent) => {
    try {
      await uninstallMarketplaceEmployee({ instanceId: agent.id });
      await prefetchMarketplaceCatalog();
      toast.success(`“${agent.name}”已卸载`);
    } catch (error) {
      toast.error(`卸载失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [uninstallMarketplaceEmployee, prefetchMarketplaceCatalog]);

  const handleUpdateMarketAgent = useCallback(async (agent: MarketplaceAgent) => {
    const installedEmployee = installedEmployeesByMarketId.get(agent.slug)?.[0];
    if (!installedEmployee) return;
    setIsUpdating(true);
    try {
      await updateEmployee(installedEmployee.instanceId, {});
      await prefetchMarketplaceCatalog();
      toast.success(`“${agent.name}”升级成功`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      if (isAlreadyLatestUpdateError(error)) {
        toast.info(`"${agent.name}" 当前已是最新版本`);
      } else {
        toast.error(`升级失败：${getErrorMessage(error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } finally {
      setIsUpdating(false);
    }
  }, [installedEmployeesByMarketId, updateEmployee, prefetchMarketplaceCatalog]);

  return (
    <div className="relative flex flex-col -m-6 h-[calc(100vh-2.5rem)] overflow-hidden bg-background">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 dark:hidden"
        style={{
          background:
            'radial-gradient(120% 80% at 80% 20%, hsl(28 60% 95% / 0.85) 0%, hsl(28 50% 96% / 0.6) 35%, hsl(0 0% 100% / 0) 70%), radial-gradient(80% 60% at 20% 90%, hsl(18 80% 92% / 0.55) 0%, hsl(0 0% 100% / 0) 60%)',
        }}
      />

      <div className="relative z-10 flex flex-col h-full w-full max-w-[1400px] mx-auto px-8 pt-[2em] pb-6">
        <div className="flex flex-row items-start justify-between mb-5 shrink-0 gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-foreground leading-tight">岗位助理</h1>
            <p className="text-[13px] text-muted-foreground mt-1">发现、启用并管理面向你工作的岗位助理</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-6 mb-4 shrink-0">
          <div className="flex items-center gap-6">
            {([
              { key: 'mine', label: '我的岗位助理' },
              { key: 'market', label: '岗位助理广场' },
            ] as const).map(({ key, label }) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveTab(key)}
                  className={cn(
                    'relative pb-2.5 text-[14px] transition-colors',
                    isActive
                      ? 'text-foreground font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {isActive && (
                    <span className="absolute -bottom-px left-1/2 -translate-x-1/2 w-6 h-[2px] bg-[#FF922B] rounded-full" />
                  )}
                </button>
              );
            })}
          </div>

          {activeTab === 'mine' ? (
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative flex items-center bg-[#FFF2E5] dark:bg-[#FF922B]/15 rounded-full px-3 py-1.5 border border-transparent focus-within:border-[#FF922B]/40 transition-colors w-64 -translate-y-[2px]">
                <Search className="h-3.5 w-3.5 text-[#FF922B] shrink-0" />
                <input
                  placeholder="搜索岗位助理"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="ml-2 bg-transparent outline-none w-full text-[13px] text-foreground placeholder:text-[#FF922B]/80"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    className="text-[#FF922B]/70 hover:text-[#FF922B] shrink-0 ml-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
                title="刷新"
                disabled={employeesLoading || isUpdating}
                onClick={() => void refreshMyDigitalEmployees()}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', employeesLoading && 'animate-spin')} />
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-4 shrink-0 flex-1">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-0 rounded">
                  {(['download_count', 'update_time'] as const).map((sort, index) => {
                    const labels = {
                      download_count: '最热',
                      update_time: '最新',
                    };
                    const isSelected = sortBy === sort;
                    return (
                      <button
                        key={sort}
                        type="button"
                        onClick={() => setSortBy(sort)}
                        className={cn(
                          'px-3 py-1 text-[12.5px] transition-all flex items-center justify-center',
                          index === 0 && 'rounded-l',
                          index === 1 && 'rounded-r',
                          isSelected
                            ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                        )}
                      >
                        {labels[sort]}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-0 rounded">
                  {(['all', 'installed', 'uninstalled'] as const).map((filter, index) => {
                    const counts = {
                      all: resolvedMarketAgents.length,
                      installed: installedMarketCount,
                      uninstalled: uninstalledMarketCount,
                    };
                    const labels = {
                      all: '全部',
                      installed: '已安装',
                      uninstalled: '未安装',
                    };
                    const isSelected = installFilter === filter;
                    return (
                      <button
                        key={filter}
                        type="button"
                        onClick={() => setInstallFilter(filter)}
                        className={cn(
                          'px-3 py-1 text-[12.5px] transition-all flex items-center justify-center',
                          index === 0 && 'rounded-l',
                          index === 2 && 'rounded-r',
                          isSelected
                            ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                        )}
                      >
                        {labels[filter]} ({counts[filter]})
                      </button>
                    );
                  })}
                </div>

                <div className="relative flex items-center bg-[#FFF2E5] dark:bg-[#FF922B]/15 rounded-full px-3 py-1.5 border border-transparent focus-within:border-[#FF922B]/40 transition-colors w-64">
                  <Search className="h-3.5 w-3.5 text-[#FF922B] shrink-0" />
                  <input
                    placeholder="搜索岗位助理"
                    value={marketQuery}
                    onChange={(e) => setMarketQuery(e.target.value)}
                    className="ml-2 bg-transparent outline-none w-full text-[13px] text-foreground placeholder:text-[#FF922B]/80"
                  />
                  {marketQuery && (
                    <button
                      type="button"
                      onClick={() => setMarketQuery('')}
                      className="text-[#FF922B]/70 hover:text-[#FF922B] shrink-0 ml-1"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
                  title="刷新"
                  disabled={marketLoading || isUpdating}
                  onClick={() => void Promise.all([fetchMarketAgents(), prefetchMarketplaceCatalog()])}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', marketLoading && 'animate-spin')} />
                </Button>
              </div>
            </div>
          )}
        </div>

        {activeTab === 'market' && (
          <div className="flex flex-wrap gap-2 mb-4 shrink-0">
            {MARKETPLACE_CATEGORY_OPTIONS.map(({ key, label }) => {
              const isActive = selectedCategory === key;
              return (
                <button
                  key={key || 'all'}
                  type="button"
                  onClick={() => setSelectedCategory(key)}
                  className={cn(
                    'px-3.5 py-1 rounded-full text-[13px] transition-all',
                    isActive
                      ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                      : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
                  )}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {activeTab === 'mine' ? (
            employeesLoading && myAgents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Loader2 className="h-8 w-8 mb-4 animate-spin opacity-50" />
                <p>加载中...</p>
              </div>
            ) : filteredMyAgents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Package className="h-10 w-10 mb-4 opacity-50" />
                <p>{searchQuery.trim() ? '尝试不同的搜索词' : '暂无可用岗位助理'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-stretch">
                {filteredMyAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onToggle={(enabled) => handleToggleAgent(agent.id, enabled)}
                    onUninstall={() => void handleUninstallMyAgent(agent)}
                    onUse={() => handleUseAgent(agent)}
                  />
                ))}
              </div>
            )
          ) : (
            <>
              {marketSearchError && (
                <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <span>{MARKETPLACE_SEARCH_ERROR_MESSAGE}</span>
                </div>
              )}

              {marketLoading && marketAgents.length === 0 && !isUpdating && (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <RefreshCw className="h-8 w-8 mb-4 animate-spin opacity-50" />
                  <p>加载中...</p>
                </div>
              )}

              {!marketLoading && filteredMarketAgents.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-stretch">
                  {filteredMarketAgents.map((agent) => (
                    <MarketplaceAgentCard
                      key={agent.slug}
                      agent={agent}
                      isLoading={
                        !isUpdating && (
                          installingMarketEmployeeId === agent.slug
                          || (
                            updatingInstanceId != null
                            && (installedEmployeesByMarketId.get(agent.slug)
                              ?.some((employee) => employee.instanceId === updatingInstanceId) ?? false)
                          )
                        )
                      }
                      onInstall={() => void handleInstallMarketAgent(agent)}
                      onUninstall={() => void handleUninstallMarketAgent(agent)}
                      onUpdate={() => void handleUpdateMarketAgent(agent)}
                    />
                  ))}
                </div>
              )}

              {!marketLoading && filteredMarketAgents.length === 0 && !marketSearchError && (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Package className="h-10 w-10 mb-4 opacity-50" />
                  <p>{marketQuery.trim() ? '未找到匹配的岗位助理' : '暂无岗位助理'}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {isUpdating && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/90 backdrop-blur-[2px] pointer-events-auto">
          <LoaderBadge />
        </div>
      )}
    </div>
  );
}

export default DigitalEmployee;
