import { useEffect, useState } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from 'react-i18next';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useSettingsStore } from '@/stores/settings';
import { useTokenUsageStore } from '@/stores/token-usage';
import { trackUiEvent } from '@/lib/telemetry';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { FeedbackState } from '@/components/common/FeedbackState';
import { CenteredLoader } from '@/components/common/LoadingSpinner';
import {
  filterUsageHistoryByWindow,
  groupUsageHistory,
  resolveVisibleUsageHistory,
  type UsageGroupBy,
  type UsageHistoryEntry,
  type UsageWindow,
} from './usage-history';

const HIDDEN_USAGE_MARKERS = ['gateway-injected', 'delivery-mirror'];

function isHiddenUsageSource(source?: string): boolean {
  if (!source) return false;
  const normalizedSource = source.trim().toLowerCase();
  return HIDDEN_USAGE_MARKERS.some((marker) => normalizedSource.includes(marker));
}

export function Models() {
  const { t } = useTranslation(['dashboard', 'settings']);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const fetchStateStatus = useTokenUsageStore((state) => state.status);
  const fetchStateData = useTokenUsageStore((state) => state.entries);
  const fetchStateStableData = useTokenUsageStore((state) => state.stableEntries);
  const fetchTokenUsageHistory = useTokenUsageStore((state) => state.fetchTokenUsageHistory);

  const [usageGroupBy, setUsageGroupBy] = useState<UsageGroupBy>('model');
  const [usageWindow, setUsageWindow] = useState<UsageWindow>('7d');
  const [usagePage, setUsagePage] = useState(1);
  const [selectedUsageEntry, setSelectedUsageEntry] = useState<UsageHistoryEntry | null>(null);
  function formatUsageSource(source?: string): string | undefined {
    if (!source) return undefined;

    if (isHiddenUsageSource(source)) {
      return undefined;
    }

    return source;
  }

  function shouldHideUsageEntry(entry: UsageHistoryEntry): boolean {
    return (
      isHiddenUsageSource(entry.provider)
      || isHiddenUsageSource(entry.model)
    );
  }

  useEffect(() => {
    trackUiEvent('models.page_viewed');
  }, []);

  const usageHistory = isGatewayRunning
    ? fetchStateData.filter((entry) => !shouldHideUsageEntry(entry))
    : [];
  const stableUsageHistory = isGatewayRunning
    ? fetchStateStableData.filter((entry) => !shouldHideUsageEntry(entry))
    : [];
  const visibleUsageHistory = resolveVisibleUsageHistory(usageHistory, stableUsageHistory, {
    preferStableOnEmpty: isGatewayRunning && fetchStateStatus === 'loading',
  });
  const filteredUsageHistory = filterUsageHistoryByWindow(visibleUsageHistory, usageWindow);
  const usageGroups = groupUsageHistory(filteredUsageHistory, usageGroupBy);
  const usagePageSize = 5;
  const usageTotalPages = Math.max(1, Math.ceil(filteredUsageHistory.length / usagePageSize));
  const safeUsagePage = Math.min(usagePage, usageTotalPages);
  const pagedUsageHistory = filteredUsageHistory.slice((safeUsagePage - 1) * usagePageSize, safeUsagePage * usagePageSize);
  const usageLoading = isGatewayRunning && fetchStateStatus === 'loading' && visibleUsageHistory.length === 0;
  const usageRefreshing = isGatewayRunning && fetchStateStatus === 'loading' && visibleUsageHistory.length > 0;
  const showUsagePagination = !usageLoading && visibleUsageHistory.length > 0 && filteredUsageHistory.length > 0;

  const handleRefreshTokenUsage = () => {
    void fetchTokenUsageHistory({ force: true });
  };

  return (
    <div data-testid="models-page" className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="relative z-10 w-full max-w-[1400px] mx-auto flex flex-col h-full px-8 pt-[2em] pb-6">

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-5 shrink-0 gap-3">
          <div className="min-w-0">
            <h1 data-testid="models-page-title" className="text-[20px] font-bold text-foreground leading-tight">
              {t('dashboard:models.title')}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1">
              {t('dashboard:models.subtitle')}
            </p>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0">
          {/* Content Area */}
          <div className="flex-1 overflow-y-auto pr-2 min-h-0 -mr-2 space-y-8 pb-4">

          {/* AI Providers Section */}
          <ProvidersSettings addDialogInitialProvider="custom" />

          {/* Token Usage History Section */}
          <div>
            <h2 className="text-[15px] font-bold text-foreground mb-3 leading-tight">
              {t('dashboard:recentTokenHistory.title', 'Token Usage History')}
            </h2>
            <div>
              {usageLoading ? (
                <CenteredLoader
                  message={t('dashboard:recentTokenHistory.loading')}
                  testId="models-token-usage-loading"
                />
              ) : visibleUsageHistory.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-2xl border border-transparent border-dashed">
                  <FeedbackState state="empty" title={t('dashboard:recentTokenHistory.empty')} />
                </div>
              ) : filteredUsageHistory.length === 0 ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground bg-black/5 dark:bg-white/5 rounded-2xl border border-transparent border-dashed">
                  <FeedbackState state="empty" title={t('dashboard:recentTokenHistory.emptyForWindow')} />
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-3">
                      <div className="flex items-center gap-1 rounded-lg bg-transparent p-1">
                        <button
                          type="button"
                          onClick={() => {
                            setUsageGroupBy('model');
                            setUsagePage(1);
                          }}
                          className={cn(
                            'h-7 px-3 rounded-md text-[12.5px] font-medium transition-colors',
                            usageGroupBy === 'model'
                              ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                              : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                          )}
                        >
                          {t('dashboard:recentTokenHistory.groupByModel')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setUsageGroupBy('day');
                            setUsagePage(1);
                          }}
                          className={cn(
                            'h-7 px-3 rounded-md text-[12.5px] font-medium transition-colors',
                            usageGroupBy === 'day'
                              ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                              : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                          )}
                        >
                          {t('dashboard:recentTokenHistory.groupByTime')}
                        </button>
                      </div>
                      <div className="flex items-center gap-1 rounded-lg bg-transparent p-1">
                        <button
                          type="button"
                          onClick={() => {
                            setUsageWindow('7d');
                            setUsagePage(1);
                          }}
                          className={cn(
                            'h-7 px-3 rounded-md text-[12.5px] font-medium transition-colors',
                            usageWindow === '7d'
                              ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                              : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                          )}
                        >
                          {t('dashboard:recentTokenHistory.last7Days')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setUsageWindow('30d');
                            setUsagePage(1);
                          }}
                          className={cn(
                            'h-7 px-3 rounded-md text-[12.5px] font-medium transition-colors',
                            usageWindow === '30d'
                              ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                              : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                          )}
                        >
                          {t('dashboard:recentTokenHistory.last30Days')}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setUsageWindow('all');
                            setUsagePage(1);
                          }}
                          className={cn(
                            'h-7 px-3 rounded-md text-[12.5px] font-medium transition-colors',
                            usageWindow === 'all'
                              ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
                              : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
                          )}
                        >
                          {t('dashboard:recentTokenHistory.allTime')}
                        </button>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <p className="text-[13px] font-medium text-muted-foreground">
                        {usageRefreshing
                          ? t('dashboard:recentTokenHistory.loading')
                          : t('dashboard:recentTokenHistory.showingLast', { count: filteredUsageHistory.length })}
                      </p>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        data-testid="token-usage-refresh"
                        aria-label={t('dashboard:recentTokenHistory.refresh')}
                        title={t('dashboard:recentTokenHistory.refresh')}
                        onClick={handleRefreshTokenUsage}
                        disabled={usageRefreshing}
                        className="h-8 w-8 rounded-lg text-muted-foreground hover:text-[#FF922B] hover:bg-[#FFF2E5] dark:hover:bg-[#FF922B]/15"
                      >
                        <RefreshCw className={cn('h-4 w-4', usageRefreshing && 'animate-spin')} />
                      </Button>
                    </div>
                  </div>

                  <UsageBarChart
                    groups={usageGroups}
                    emptyLabel={t('dashboard:recentTokenHistory.empty')}
                    totalLabel={t('dashboard:recentTokenHistory.totalTokens')}
                    inputLabel={t('dashboard:recentTokenHistory.inputShort')}
                    outputLabel={t('dashboard:recentTokenHistory.outputShort')}
                    cacheLabel={t('dashboard:recentTokenHistory.cacheShort')}
                  />

                  <div className="space-y-3 pt-2">
                    {pagedUsageHistory.map((entry) => (
                      <div
                        key={`${entry.sessionId}-${entry.timestamp}`}
                        data-testid="token-usage-entry"
                        className="group rounded-xl bg-white dark:bg-card border border-black/[0.06] dark:border-white/10 p-4 hover:bg-[#FFF7EC] hover:border-[#FFD79A]/60 dark:hover:bg-white/[0.04] transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-semibold text-[15px] text-foreground truncate">
                              {entry.model || t('dashboard:recentTokenHistory.unknownModel')}
                            </p>
                            <p className="text-[13px] text-muted-foreground truncate mt-0.5">
                              {[formatUsageSource(entry.provider), formatUsageSource(entry.agentId), entry.sessionId].filter(Boolean).join(' • ')}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className={getUsageTotalClass(entry)}>
                              {formatUsageTotal(entry)}
                            </p>
                            {entry.usageStatus === 'missing' && (
                              <p className="text-[12px] text-muted-foreground mt-0.5">
                                {t('dashboard:recentTokenHistory.noUsage')}
                              </p>
                            )}
                            {entry.usageStatus === 'error' && (
                              <p className="text-[12px] text-red-500 dark:text-red-400 mt-0.5">
                                {t('dashboard:recentTokenHistory.usageParseError')}
                              </p>
                            )}
                            <p className="text-[12px] text-muted-foreground mt-0.5">
                              {formatUsageTimestamp(entry.timestamp)}
                            </p>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[12.5px] font-medium text-muted-foreground">
                          {entry.usageStatus === 'available' || entry.usageStatus === undefined ? (
                            <>
                              <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-sky-500"></div>{t('dashboard:recentTokenHistory.input', { value: formatTokenCount(entry.inputTokens) })}</span>
                              <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-[#FF922B]"></div>{t('dashboard:recentTokenHistory.output', { value: formatTokenCount(entry.outputTokens) })}</span>
                              {entry.cacheReadTokens > 0 && (
                                <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div>{t('dashboard:recentTokenHistory.cacheRead', { value: formatTokenCount(entry.cacheReadTokens) })}</span>
                              )}
                              {entry.cacheWriteTokens > 0 && (
                                <span className="flex items-center gap-1.5"><div className="w-2 h-2 rounded-full bg-emerald-500"></div>{t('dashboard:recentTokenHistory.cacheWrite', { value: formatTokenCount(entry.cacheWriteTokens) })}</span>
                              )}
                            </>
                          ) : (
                            <span className="text-[12px]">
                              {entry.usageStatus === 'missing'
                                ? t('dashboard:recentTokenHistory.noUsage')
                                : t('dashboard:recentTokenHistory.usageParseError')}
                            </span>
                          )}
                          {typeof entry.costUsd === 'number' && Number.isFinite(entry.costUsd) && (
                            <span className="flex items-center gap-1.5 ml-auto text-[#FE7B00] bg-[#FFF2E5] dark:text-primary dark:bg-[#FF922B]/15 px-2 py-0.5 rounded-md font-medium">{t('dashboard:recentTokenHistory.cost', { amount: entry.costUsd.toFixed(4) })}</span>
                          )}
                          {devModeUnlocked && entry.content && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 rounded-full px-2.5 text-[11.5px] border-black/10 dark:border-white/10"
                              onClick={() => setSelectedUsageEntry(entry)}
                            >
                              {t('dashboard:recentTokenHistory.viewContent')}
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          </div>

          {showUsagePagination && (
            <div className="shrink-0 flex w-full items-center justify-between gap-3 pt-3 pr-2 -mr-2">
              <p className="text-[13px] font-medium text-muted-foreground">
                {t('dashboard:recentTokenHistory.page', { current: safeUsagePage, total: usageTotalPages })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUsagePage((page) => Math.max(1, page - 1))}
                  disabled={safeUsagePage <= 1}
                  className="rounded-lg px-3 h-8 text-[13px] border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
                >
                  <ChevronLeft className="h-4 w-4 mr-1" />
                  {t('dashboard:recentTokenHistory.prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setUsagePage((page) => Math.min(usageTotalPages, page + 1))}
                  disabled={safeUsagePage >= usageTotalPages}
                  className="rounded-lg px-3 h-8 text-[13px] border-black/10 dark:border-white/10 bg-transparent hover:bg-black/5 dark:hover:bg-white/5"
                >
                  {t('dashboard:recentTokenHistory.next')}
                  <ChevronRight className="h-4 w-4 ml-1" />
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      {devModeUnlocked && selectedUsageEntry && (
        <UsageContentPopup
          entry={selectedUsageEntry}
          onClose={() => setSelectedUsageEntry(null)}
          title={t('dashboard:recentTokenHistory.contentDialogTitle')}
          closeLabel={t('dashboard:recentTokenHistory.close')}
          unknownModelLabel={t('dashboard:recentTokenHistory.unknownModel')}
        />
      )}
    </div>
  );
}

function formatTokenCount(value: number): string {
  return Intl.NumberFormat().format(value);
}

function getUsageTotalClass(entry: UsageHistoryEntry): string {
  if (entry.usageStatus === 'error') return 'font-bold text-[15px] text-red-500 dark:text-red-400';
  if (entry.usageStatus === 'missing') return 'font-bold text-[15px] text-muted-foreground';
  return 'font-bold text-[15px]';
}

function formatUsageTotal(entry: UsageHistoryEntry): string {
  if (entry.usageStatus === 'error') return '✕';
  if (entry.usageStatus === 'missing') return '—';
  return formatTokenCount(entry.totalTokens);
}

function formatUsageTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function UsageBarChart({
  groups,
  emptyLabel,
  totalLabel,
  inputLabel,
  outputLabel,
  cacheLabel,
}: {
  groups: Array<{
    label: string;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    cacheTokens: number;
  }>;
  emptyLabel: string;
  totalLabel: string;
  inputLabel: string;
  outputLabel: string;
  cacheLabel: string;
}) {
  if (groups.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-black/10 dark:border-white/10 p-8 text-center text-[14px] font-medium text-muted-foreground">
        {emptyLabel}
      </div>
    );
  }

  const maxTokens = Math.max(...groups.map((group) => group.totalTokens), 1);

  return (
    <div className="space-y-4 bg-transparent py-5">
      <div className="flex flex-wrap items-center justify-center gap-5 text-[12px] font-medium text-muted-foreground mb-2">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-sky-500" />
          {inputLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-emerald-500" />
          {cacheLabel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-[#FF922B]" />
          {outputLabel}
        </span>
      </div>
      {groups.map((group) => (
        <div key={group.label} className="space-y-1.5">
          <div className="flex items-center justify-between gap-3 text-[13px]">
            <span className="truncate font-medium text-foreground">
              {group.label} <span className="text-muted-foreground font-normal">| Tokens {formatTokenCount(group.totalTokens)}</span>
            </span>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="h-3 overflow-hidden rounded-full bg-black/[0.04] dark:bg-white/5 cursor-pointer">
                <div
                  className="flex h-full overflow-hidden rounded-full"
                  style={{
                    width: group.totalTokens > 0
                      ? `${Math.max((group.totalTokens / maxTokens) * 100, 6)}%`
                      : '0%',
                  }}
                >
                  {group.inputTokens > 0 && (
                    <div
                      className="h-full bg-sky-500"
                      style={{ width: `${(group.inputTokens / group.totalTokens) * 100}%` }}
                    />
                  )}
                  {group.cacheTokens > 0 && (
                    <div
                      className="h-full bg-emerald-500"
                      style={{ width: `${(group.cacheTokens / group.totalTokens) * 100}%` }}
                    />
                  )}
                  {group.outputTokens > 0 && (
                    <div
                      className="h-full bg-[#FF922B]"
                      style={{ width: `${(group.outputTokens / group.totalTokens) * 100}%` }}
                    />
                  )}
                </div>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={5} className="bg-black/85 text-white px-3 py-2 rounded-lg shadow-none relative overflow-visible">
              <div className="absolute -top-1.5 left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[6px] border-b-black/85"></div>
              <div className="space-y-1.5 text-sm">
                <div className="text-white">{group.label}</div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-sky-500" />
                  <span>{inputLabel}: {formatTokenCount(group.inputTokens)} token</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-emerald-500" />
                  <span>{cacheLabel}: {formatTokenCount(group.cacheTokens)} token</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-[#FF922B]" />
                  <span>{outputLabel}: {formatTokenCount(group.outputTokens)} token</span>
                </div>
              </div>
            </TooltipContent>
          </Tooltip>
        </div>
      ))}
    </div>
  );
}

export default Models;

function UsageContentPopup({
  entry,
  onClose,
  title,
  closeLabel,
  unknownModelLabel,
}: {
  entry: UsageHistoryEntry;
  onClose: () => void;
  title: string;
  closeLabel: string;
  unknownModelLabel: string;
}) {
  return (
    <ModalOverlay className="px-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-3xl rounded-2xl border border-black/10 dark:border-white/10 bg-background shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-black/10 dark:border-white/10 px-5 py-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">{title}</p>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {(entry.model || unknownModelLabel)} • {formatUsageTimestamp(entry.timestamp)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-full"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
          <pre className="whitespace-pre-wrap break-words text-sm text-foreground font-mono">
            {entry.content}
          </pre>
        </div>
        <div className="flex justify-end border-t border-black/10 dark:border-white/10 px-5 py-3">
          <Button variant="outline" onClick={onClose}>
            {closeLabel}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
