import { useCallback, useMemo, useState } from 'react';
import {
  Search,
  Lock,
  Package,
  X,
  RefreshCw,
  Trash2,
  Download,
  User as UserIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  MARKETPLACE_CATEGORY_OPTIONS,
  MOCK_MARKETPLACE_AGENTS,
  MOCK_MY_AGENTS,
  type MockAgent,
  type MockMarketplaceAgent,
} from './mock-data';

const AGENT_COLOR = 'bg-[#FF922B]';
const MAX_TAG_COUNT = 3;
const MAX_TAG_CHARS = 5;

function formatTagLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length <= MAX_TAG_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_TAG_CHARS)}...`;
}

function AgentTagRow({ tags }: { tags: string[] }) {
  const visibleTags = tags.slice(0, MAX_TAG_COUNT);
  if (visibleTags.length === 0) return null;

  return (
    <div className="mt-2 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
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

function getAgentInitial(name: string): string {
  if (!name) return '智';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : '智';
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

interface AgentCardProps {
  agent: MockAgent;
  onToggle: (enabled: boolean) => void;
}

function AgentCard({ agent, onToggle }: AgentCardProps) {
  const initial = getAgentInitial(agent.name);
  const versionLabel = formatVersion(agent.version);
  const authorLabel = agent.author.trim() || '未知作者';

  return (
    <div
      className={cn(
        'group relative flex flex-col text-left rounded-2xl border transition-colors p-4 overflow-hidden',
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
              <h3 className="text-[14px] font-semibold text-foreground truncate">
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
        <div className="shrink-0">
          <Switch
            className="origin-right scale-[0.75]"
            checked={agent.enabled}
            onCheckedChange={onToggle}
            disabled={agent.isCore}
          />
        </div>
      </div>

      <AgentTagRow tags={agent.tags} />

      <Tooltip>
        <TooltipTrigger asChild>
          <p className="mt-3 text-[12.5px] text-muted-foreground leading-[1.55] line-clamp-2 break-words min-h-[3.1em]">
            {agent.description || '—'}
          </p>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-normal break-words">
          {agent.description || '—'}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

interface MarketplaceAgentCardProps {
  agent: MockMarketplaceAgent;
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
        'group relative flex flex-col text-left rounded-2xl border transition-colors p-4 overflow-hidden',
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
            <h3 className="text-[14px] font-semibold text-foreground truncate">{agent.name}</h3>
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
              className={cn(
                'h-8 w-8 rounded-lg transition-colors shadow-none',
                'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
              )}
              title="更新"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={agent.installed ? onUninstall : onInstall}
            disabled={isLoading}
            className={cn(
              'h-8 w-8 rounded-lg transition-colors shadow-none',
              'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
            )}
            title={agent.installed ? '卸载' : '安装'}
          >
            {agent.installed ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <AgentTagRow tags={agent.tags} />

      <Tooltip>
        <TooltipTrigger asChild>
          <p className="mt-3 text-[12.5px] text-muted-foreground leading-[1.55] line-clamp-2 break-words min-h-[3.1em]">
            {agent.description || '—'}
          </p>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-normal break-words">
          {agent.description || '—'}
        </TooltipContent>
      </Tooltip>

      <div className="mt-3 flex items-center gap-4 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 max-w-[40%] truncate">
          <UserIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{author}</span>
        </span>

        <span className="inline-flex items-center gap-1" title="下载量">
          <Download className="h-3 w-3" />
          {agent.downloads}
        </span>

        {createTime && (
          <span className="inline-flex items-center gap-1">
            <RefreshCw className="h-3 w-3" />
            {createTime}
          </span>
        )}
      </div>
    </div>
  );
}

export function DigitalEmployee() {
  const [activeTab, setActiveTab] = useState<'mine' | 'market'>('mine');
  const [searchQuery, setSearchQuery] = useState('');
  const [marketQuery, setMarketQuery] = useState('');
  const [myAgents, setMyAgents] = useState<MockAgent[]>(() => [...MOCK_MY_AGENTS]);
  const [marketAgents, setMarketAgents] = useState<MockMarketplaceAgent[]>(() => [...MOCK_MARKETPLACE_AGENTS]);
  const [selectedCategory, setSelectedCategory] = useState('');
  const [installFilter, setInstallFilter] = useState<'all' | 'installed' | 'uninstalled'>('all');
  const [sortBy, setSortBy] = useState<'download_count' | 'update_time'>('download_count');

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
        if (a.enabled && !b.enabled) return -1;
        if (!a.enabled && b.enabled) return 1;
        if (a.isCore && !b.isCore) return -1;
        if (!a.isCore && b.isCore) return 1;
        return a.name.localeCompare(b.name);
      });
  }, [myAgents, searchQuery]);

  const installedMarketCount = marketAgents.filter((agent) => agent.installed).length;
  const uninstalledMarketCount = marketAgents.length - installedMarketCount;

  const filteredMarketAgents = useMemo(() => {
    const q = marketQuery.trim().toLowerCase();
    return marketAgents
      .filter((agent) => {
        if (selectedCategory && agent.category !== selectedCategory) return false;
        if (installFilter === 'installed' && !agent.installed) return false;
        if (installFilter === 'uninstalled' && agent.installed) return false;
        if (!q) return true;
        return (
          agent.name.toLowerCase().includes(q)
          || agent.description.toLowerCase().includes(q)
          || agent.author.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        if (sortBy === 'download_count') {
          return b.downloads - a.downloads;
        }
        return new Date(b.updateTime).getTime() - new Date(a.updateTime).getTime();
      });
  }, [marketAgents, marketQuery, selectedCategory, installFilter, sortBy]);

  const handleToggleAgent = useCallback((agentId: string, enabled: boolean) => {
    setMyAgents((prev) => prev.map((agent) => (
      agent.id === agentId ? { ...agent, enabled } : agent
    )));
  }, []);

  const handleInstallMarketAgent = useCallback((slug: string) => {
    setMarketAgents((prev) => prev.map((agent) => (
      agent.slug === slug ? { ...agent, installed: true } : agent
    )));
  }, []);

  const handleUninstallMarketAgent = useCallback((slug: string) => {
    setMarketAgents((prev) => prev.map((agent) => (
      agent.slug === slug ? { ...agent, installed: false } : agent
    )));
  }, []);

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
            <h1 className="text-[20px] font-bold text-foreground leading-tight">智能体</h1>
            <p className="text-[13px] text-muted-foreground mt-1">发现、启用并管理面向你工作的智能体</p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-6 mb-4 shrink-0">
          <div className="flex items-center gap-6">
            {([
              { key: 'mine', label: '我的智能体' },
              { key: 'market', label: '智能体广场' },
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
                  placeholder="搜索智能体"
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
              >
                <RefreshCw className="h-3.5 w-3.5" />
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
                            ? 'bg-[#FFF2E5] text-[#FF922B] font-medium dark:bg-[#FF922B]/15'
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
                      all: marketAgents.length,
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
                            ? 'bg-[#FFF2E5] text-[#FF922B] font-medium dark:bg-[#FF922B]/15'
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
                    placeholder="搜索智能体"
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
                  title="搜索"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
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
                      ? 'bg-[#FFF2E5] text-[#FF922B] font-medium dark:bg-[#FF922B]/15'
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
            filteredMyAgents.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Package className="h-10 w-10 mb-4 opacity-50" />
                <p>{searchQuery.trim() ? '尝试不同的搜索词' : '暂无可用智能体'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {filteredMyAgents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onToggle={(enabled) => handleToggleAgent(agent.id, enabled)}
                  />
                ))}
              </div>
            )
          ) : filteredMarketAgents.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
              <Package className="h-10 w-10 mb-4 opacity-50" />
              <p>{marketQuery.trim() ? '未找到匹配的智能体' : '暂无智能体'}</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              {filteredMarketAgents.map((agent) => (
                <MarketplaceAgentCard
                  key={agent.slug}
                  agent={agent}
                  onInstall={() => handleInstallMarketAgent(agent.slug)}
                  onUninstall={() => handleUninstallMarketAgent(agent.slug)}
                  onUpdate={() => handleInstallMarketAgent(agent.slug)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default DigitalEmployee;
