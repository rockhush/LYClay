/**
 * Skills Page
 * Browse and manage AI skills
 */
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '@/stores/chat';
import {
  Search,
  Puzzle,
  Lock,
  Package,
  X,
  AlertCircle,
  Plus,
  Trash2,
  RefreshCw,
  Globe,
  ChevronUp,
  ChevronDown,
  Upload,
  AlertTriangle,
  User as UserIcon,
  Download,
  CheckCircle2,
  Ban,
  FileText,
  BookOpen,
  Tag,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useSkillsStore } from '@/stores/skills';
import { useGatewayStore } from '@/stores/gateway';
import { LoadingSpinner, CenteredLoader } from '@/components/common/LoadingSpinner';
import { useMinLoading } from '@/hooks/use-min-loading';
import { cn } from '@/lib/utils';
import { invokeIpc } from '@/lib/api-client';
import { hostApiFetch } from '@/lib/host-api';
import { trackUiEvent } from '@/lib/telemetry';
import { toast } from 'sonner';
import type { Skill, MarketplaceSkill } from '@/types/skill';
import {
  buildMarketplaceLookupMaps,
  companyInstallEntriesToMarketplaceSkills,
  findMarketplaceSkillMatch,
  getMarketplaceSkillKey,
  isMarketplaceSkillInstalledOnDisk,
  formatSkillVersionLabel,
  resolveSkillListVersionForDisplay,
  isLyclawBuiltinSkill,
  isPlaceholderSkillDescription,
  resolveSkillDisplayName,
} from '@/lib/skill-metadata';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { flushUiStateSync, hydrateUiStateFromDisk } from '@/lib/ui-state-persistence';
import { UploadSkillDialog } from '@/components/skills/UploadSkillDialog';

const INSTALL_ERROR_CODES = new Set(['installTimeoutError', 'installRateLimitError']);
const FETCH_ERROR_CODES = new Set(['fetchTimeoutError', 'fetchRateLimitError', 'timeoutError', 'rateLimitError']);
const SEARCH_ERROR_CODES = new Set(['searchTimeoutError', 'searchRateLimitError', 'timeoutError', 'rateLimitError']);

// 统一使用品牌橙色作为技能图标背景
const SKILL_COLORS = [
  'bg-[#FF922B]',
];

// 根据技能名称生成哈希值
function getSkillHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

// 获取技能名称的首字母
function getSkillInitial(name: string): string {
  if (!name) return 'S';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : 'S';
}

// 根据技能名称获取颜色
function getSkillColor(name: string): string {
  const hash = getSkillHash(name);
  return SKILL_COLORS[hash % SKILL_COLORS.length];
}



// Skill detail dialog component
interface SkillDetailDialogProps {
  skill: Skill | null;
  marketplaceMatch?: MarketplaceSkill;
  isOpen: boolean;
  onClose: () => void;
  onOpenFolder?: (skill: Skill) => Promise<void> | void;
}

function SkillDetailDialog({ skill, marketplaceMatch, isOpen, onClose, onOpenFolder }: SkillDetailDialogProps) {
  const { t } = useTranslation('skills');
  const [skillMd, setSkillMd] = useState('');
  const [skillMdFile, setSkillMdFile] = useState('SKILL.md');
  const [skillMdLoading, setSkillMdLoading] = useState(false);
  const [skillMdError, setSkillMdError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !skill) {
      setSkillMd('');
      setSkillMdFile('SKILL.md');
      setSkillMdError(null);
      setSkillMdLoading(false);
      return;
    }

    let cancelled = false;
    setSkillMdLoading(true);
    setSkillMdError(null);
    setSkillMd('');

    void hostApiFetch<{ success: boolean; content?: string; fileName?: string; error?: string }>(
      '/api/clawhub/read-skill-md',
      {
        method: 'POST',
        body: JSON.stringify({
          skillKey: skill.id,
          slug: skill.slug,
          baseDir: skill.baseDir,
        }),
      },
    )
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.content) {
          setSkillMd(result.content);
          setSkillMdFile(result.fileName || 'SKILL.md');
        } else {
          setSkillMdError(result.error || t('detail.skillMdNotFound'));
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err);
        const notFound = /not found|404/i.test(message);
        setSkillMdError(notFound ? t('detail.skillMdNotFound') : message);
      })
      .finally(() => {
        if (!cancelled) {
          setSkillMdLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, skill, t]);

  if (!skill || !isOpen) return null;

  const displayName = resolveSkillDisplayName(skill, marketplaceMatch);
  const initial = getSkillInitial(displayName);
  const colorClass = getSkillColor(displayName);
  const displayVersion = formatSkillVersionLabel(
    resolveSkillListVersionForDisplay(skill, marketplaceMatch),
    t('card.versionUnknown', { defaultValue: '未知' }),
    { treatAsBuiltin: isLyclawBuiltinSkill(skill) },
  );
  const useInitialBadge = !skill.icon || ['⌛', '📦', '🔧'].includes(skill.icon);
  const authorLabel = (skill.author || marketplaceMatch?.author || '').trim()
    || t('card.authorFallback', { defaultValue: '未知作者' });
  const description = isPlaceholderSkillDescription(skill.description)
    ? (marketplaceMatch?.description?.trim() || skill.description || '')
    : (skill.description || marketplaceMatch?.description?.trim() || '');

  return (
    <Sheet open={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-[48rem] bg-white dark:bg-card">
        <SheetHeader className="text-left pb-2">
          <SheetTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
            {t('detail.title')}
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-4 py-2 flex-1 overflow-y-auto min-h-0">
          <div className="flex items-start gap-3.5">
            <div
              className={cn(
                'w-11 h-11 shrink-0 flex items-center justify-center rounded-xl text-[16px] font-semibold text-white shadow-sm',
                useInitialBadge ? colorClass : 'bg-white dark:bg-accent border border-black/5 dark:border-white/10',
              )}
            >
              {useInitialBadge ? initial : <span className="text-xl leading-none">{skill.icon}</span>}
            </div>

            <div className="flex-1 min-w-0">
              <h3 className="text-[16px] font-semibold text-foreground leading-tight truncate">
                {displayName}
              </h3>
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="inline-flex items-center gap-1.5 text-[12px] leading-none text-muted-foreground/70">
                  <Tag className="h-3.5 w-3.5 shrink-0" />
                  <span>{displayVersion}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 max-w-[60%] text-[12px] leading-none text-muted-foreground/70">
                  <UserIcon className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{authorLabel}</span>
                </span>
              </div>
            </div>
          </div>

          {description && (
            <section className="px-0 py-0">
              <h4 className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-foreground">
                <FileText className="h-4 w-4 text-[#FF922B]" />
                {t('detail.skillOverview')}
              </h4>
              <p className="text-[13px] leading-[1.7] text-foreground/80 whitespace-pre-wrap break-words">
                {description}
              </p>
            </section>
          )}

          <section className="min-w-0 px-0 py-0">
            <h4 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-foreground">
              <BookOpen className="h-4 w-4 text-[#FF922B]" />
              {t('detail.functionDescription')}
            </h4>

            <div className="min-w-0 max-w-full overflow-hidden rounded-xl border border-black/[0.06] bg-white dark:border-white/10 dark:bg-muted/30">
              <div className="px-3 pt-2 pb-0 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
                {skillMdFile}
              </div>
              <div className="overflow-x-auto px-3 py-3">
                {skillMdLoading ? (
                  <div className="flex items-center justify-center py-10 text-[13px] text-muted-foreground">
                    <LoadingSpinner size="sm" className="mr-2" />
                    {t('detail.skillMdLoading')}
                  </div>
                ) : skillMdError ? (
                  <p className="py-6 text-center text-[13px] text-muted-foreground">{skillMdError}</p>
                ) : (
                  <div className="prose prose-sm dark:prose-invert max-w-none w-max min-w-full text-[13px] leading-relaxed">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {skillMd}
                    </ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        <div className="mt-4 pt-4 border-t border-black/[0.06] dark:border-white/10 flex justify-end gap-2 shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="h-8 text-[13px] font-medium rounded-lg px-4 border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-sm text-foreground/80 hover:text-foreground transition-colors"
          >
            {t('detail.back')}
          </Button>
          <Button
            type="button"
            onClick={() => onOpenFolder?.(skill)}
            className="h-8 text-[13px] font-medium rounded-lg px-4 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm shadow-[#FF922B]/25 transition-colors"
          >
            {t('detail.open')}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface SkillCardProps {
  skill: Skill;
  onClick: () => void;
  onToggle: (enabled: boolean) => void;
  t: TFunction<'skills'>;
  marketplaceMatch?: MarketplaceSkill;
}

function SkillCard({ skill, onClick, onToggle, t, marketplaceMatch }: SkillCardProps) {
  const displayName = resolveSkillDisplayName(skill, marketplaceMatch);
  const initial = getSkillInitial(displayName);
  const colorClass = getSkillColor(displayName);
  const versionLabel = formatSkillVersionLabel(
    resolveSkillListVersionForDisplay(skill, marketplaceMatch),
    t('card.versionUnknown', { defaultValue: '未知' }),
    { treatAsBuiltin: isLyclawBuiltinSkill(skill) },
  );
  const authorLabel = (skill.author || marketplaceMatch?.author || '').trim()
    || t('card.authorFallback', { defaultValue: '未知作者' });
  const description = isPlaceholderSkillDescription(skill.description)
    ? (marketplaceMatch?.description?.trim() || skill.description || '—')
    : (skill.description || marketplaceMatch?.description?.trim() || '—');

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'group relative flex flex-col text-left rounded-2xl border transition-colors p-4 cursor-pointer overflow-hidden',
        'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04]',
        'hover:bg-[#FFF2E5]/70 hover:border-[#FF922B]/25 dark:hover:bg-white/[0.06]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FF922B]/40',
      )}
    >
      <div className="flex items-center gap-3 w-full">
        <div
          className={cn(
            'w-7 h-7 shrink-0 flex items-center justify-center text-[12px] font-semibold text-white rounded-lg overflow-hidden',
            colorClass,
          )}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <h3 className="text-[14px] font-semibold text-foreground truncate">
                {displayName}
              </h3>
              {skill.isCore ? (
                <Lock className="h-3 w-3 text-muted-foreground shrink-0" />
              ) : skill.isBundled ? (
                <Puzzle className="h-3 w-3 text-blue-500/70 shrink-0" />
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
        <div
          className="shrink-0"
          onClick={(e) => {
            e.stopPropagation();
          }}
        >
          <Switch
            className="origin-right scale-[0.75]"
            checked={skill.enabled}
            onCheckedChange={(checked) => onToggle(checked)}
            disabled={skill.isCore}
          />
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <p className="mt-3 text-[12.5px] text-muted-foreground leading-[1.55] line-clamp-2 break-words min-h-[3.1em]">
            {description}
          </p>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-normal break-words">
          {description}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

interface MarketplaceSkillCardProps {
  skill: MarketplaceSkill;
  isInstalled: boolean;
  isLoading: boolean;
  onInstall: () => void;
  onUninstall: () => void;
  t: TFunction<'skills'>;
}

function MarketplaceSkillCard({
  skill,
  isInstalled,
  isLoading,
  onInstall,
  onUninstall,
  t,
}: MarketplaceSkillCardProps) {
  const initial = getSkillInitial(skill.name);
  const colorClass = getSkillColor(skill.name);
  const versionLabel = formatSkillVersionLabel(
    skill.version,
    t('card.versionUnknown', { defaultValue: '未知' }),
  );
  const author =
    (skill.author || '').trim() ||
    t('card.authorFallback', { defaultValue: '未知作者' });
  const downloads =
    typeof skill.downloads === 'number' && Number.isFinite(skill.downloads)
      ? skill.downloads
      : null;

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
            colorClass,
          )}
        >
          {initial}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-col gap-0.5">
            <h3 className="text-[14px] font-semibold text-foreground truncate">{skill.name}</h3>
            <span className="text-[11px] font-mono text-muted-foreground/70 shrink-0">
              {versionLabel}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={(e) => {
              e.stopPropagation();
              if (isInstalled) onUninstall();
              else onInstall();
            }}
            disabled={isLoading}
            className={cn(
              'h-8 w-8 rounded-lg transition-colors shadow-none',
              'bg-[#FFF2E5] text-[#FF922B] hover:bg-[#FF922B] hover:text-white',
            )}
            title={isInstalled ? t('detail.uninstall') : t('actions.installSkill')}
          >
            {isLoading ? (
              <LoadingSpinner size="sm" />
            ) : isInstalled ? (
              <Trash2 className="h-3.5 w-3.5" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <p className="mt-3 text-[12.5px] text-muted-foreground leading-[1.55] line-clamp-2 break-words min-h-[3.1em]">
            {skill.description || '—'}
          </p>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-xs whitespace-normal break-words">
          {skill.description || '—'}
        </TooltipContent>
      </Tooltip>

      <div className="mt-3 flex items-center gap-4 text-[11.5px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 max-w-[40%] truncate">
          <UserIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{author}</span>
        </span>

        {downloads !== null && (
          <span
            className="inline-flex items-center gap-1"
            title={t('card.downloadsLabel', { defaultValue: '下载量' })}
          >
            <Download className="h-3 w-3" />
            {downloads}
          </span>
        )}
      </div>
    </div>
  );
}

export function Skills() {
  const {
    skills,
    loading,
    error,
    fetchSkills,
    enableSkill,
    disableSkill,
    searchResults,
    searchSkills,
    installSkill,
    uninstallSkill,
    setSearchResults,
    searching,
    searchError,
    installing,
    companyInstallMap,
    companyInstallEntries,
  } = useSkillsStore();
  const { t } = useTranslation('skills');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const [searchQuery, setSearchQuery] = useState('');
  const [installQuery, setInstallQuery] = useState('');
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [selectedType, setSelectedType] = useState<string>('');
  const [selectedSource, setSelectedSource] = useState<'all' | 'built-in' | 'marketplace'>('all');
  const [installFilter, setInstallFilter] = useState<'all' | 'installed' | 'uninstalled'>('all');
  const [sortBy, setSortBy] = useState<'download_count' | 'update_time'>('download_count');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [scrollPosition, setScrollPosition] = useState(0);
  const [uploadSkillOpen, setUploadSkillOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'mine' | 'market'>('mine');
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  // Close the "新增技能" dropdown on outside click
  useEffect(() => {
    if (!addMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setAddMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [addMenuOpen]);

  const isGatewayRunning = gatewayStatus.state === 'running';
  const isGatewayReady = isGatewayRunning && gatewayStatus.gatewayReady === true;
  const [showGatewayWarning, setShowGatewayWarning] = useState(false);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  useEffect(() => {
    if (!isGatewayReady) return;
    void fetchSkills();
  }, [isGatewayReady, fetchSkills]);

  useEffect(() => {
    let timer: NodeJS.Timeout;
    if (!isGatewayRunning) {
      timer = setTimeout(() => {
        setShowGatewayWarning(true);
      }, 1500);
    } else {
      setShowGatewayWarning(false);
    }
    return () => clearTimeout(timer);
  }, [isGatewayRunning]);

  const safeSkills = Array.isArray(skills) ? skills : [];
  
  // 调试：输出所有技能信息
  // console.log('[Skills] All skills:', safeSkills.map(s => ({ id: s.id, name: s.name, slug: s.slug, isBundled: s.isBundled })));
  
  const filteredSkills = safeSkills.filter((skill) => {
    const q = searchQuery.toLowerCase().trim();
    const matchesSearch =
      q.length === 0 ||
      skill.name.toLowerCase().includes(q) ||
      skill.description.toLowerCase().includes(q) ||
      skill.id.toLowerCase().includes(q) ||
      (skill.slug || '').toLowerCase().includes(q) ||
      (skill.author || '').toLowerCase().includes(q);

    let matchesSource = true;
    const isBuiltin = isLyclawBuiltinSkill(skill);
    if (selectedSource === 'built-in') {
      matchesSource = isBuiltin;
    } else if (selectedSource === 'marketplace') {
      matchesSource = !isBuiltin;
    }

    return matchesSearch && matchesSource;
  }).sort((a, b) => {
    if (a.enabled && !b.enabled) return -1;
    if (!a.enabled && b.enabled) return 1;
    if (a.isCore && !b.isCore) return -1;
    if (!a.isCore && b.isCore) return 1;
    return a.name.localeCompare(b.name);
  });

  const sourceStats = {
    all: safeSkills.length,
    builtIn: safeSkills.filter((s) => isLyclawBuiltinSkill(s)).length,
    marketplace: safeSkills.filter((s) => !isLyclawBuiltinSkill(s)).length,
  };

  // Build lookup tables so installed skills can borrow author / download
  // count from the marketplace (技能广场) response when available.
  const marketplaceLookup = useMemo(() => (
    buildMarketplaceLookupMaps([
      ...searchResults,
      ...companyInstallEntriesToMarketplaceSkills(companyInstallEntries),
    ])
  ), [searchResults, companyInstallEntries]);

  const marketplaceCategoryOptions = [
    { key: '', label: '全部' },
    { key: 'finance', label: '财经' },
    { key: 'rnd', label: '研发' },
    { key: 'hr', label: '人力' },
    { key: 'manufacture', label: '智造' },
    { key: 'procurement', label: '采购' },
    { key: 'business', label: '商务' },
    { key: 'legal', label: '法务' },
    { key: 'office', label: '办公' },
    { key: 'it', label: 'IT' },
    // { key: 'logistics', label: '物流' },
    { key: 'other', label: '其他' },
  ];

  const isMarketplaceSkillInstalled = useCallback(
    (skill: MarketplaceSkill) => isMarketplaceSkillInstalledOnDisk(skill, safeSkills, companyInstallMap),
    [safeSkills, companyInstallMap],
  );

  const installedMarketplaceCount = searchResults.filter(isMarketplaceSkillInstalled).length;
  const uninstalledMarketplaceCount = searchResults.length - installedMarketplaceCount;
  const visibleMarketplaceSkills = searchResults.filter((skill) => {
    const isInstalled = isMarketplaceSkillInstalled(skill);
    if (installFilter === 'installed') return isInstalled;
    if (installFilter === 'uninstalled') return !isInstalled;
    return true;
  });

  const bulkToggleVisible = useCallback(async (enable: boolean) => {
    const candidates = filteredSkills.filter((skill) => !skill.isCore && skill.enabled !== enable);
    if (candidates.length === 0) {
      toast.info(enable ? t('toast.noBatchEnableTargets') : t('toast.noBatchDisableTargets'));
      return;
    }

    let succeeded = 0;
    for (const skill of candidates) {
      try {
        if (enable) {
          await enableSkill(skill.id);
        } else {
          await disableSkill(skill.id);
        }
        succeeded += 1;
      } catch {
        // Continue to next skill and report final summary.
      }
    }

    trackUiEvent('skills.batch_toggle', { enable, total: candidates.length, succeeded });
    if (succeeded === candidates.length) {
      toast.success(enable ? t('toast.batchEnabled', { count: succeeded }) : t('toast.batchDisabled', { count: succeeded }));
      return;
    }
    toast.warning(t('toast.batchPartial', { success: succeeded, total: candidates.length }));
  }, [disableSkill, enableSkill, filteredSkills, t]);

  const handleToggle = useCallback(async (skillId: string, enable: boolean) => {
    try {
      if (enable) {
        await enableSkill(skillId);
        toast.success(t('toast.enabled'));
      } else {
        await disableSkill(skillId);
        toast.success(t('toast.disabled'));
      }
    } catch (err) {
      toast.error(String(err));
    }
  }, [enableSkill, disableSkill, t]);

  const hasInstalledSkills = safeSkills.some(s => !s.isBundled);

  const handleOpenSkillsFolder = useCallback(async () => {
    try {
      const skillsDir = await invokeIpc<string>('openclaw:getSkillsDir');
      if (!skillsDir) {
        throw new Error('Skills directory not available');
      }
      const result = await invokeIpc<string>('shell:openPath', skillsDir);
      if (result) {
        if (result.toLowerCase().includes('no such file') || result.toLowerCase().includes('not found') || result.toLowerCase().includes('failed to open')) {
          toast.error(t('toast.failedFolderNotFound'));
        } else {
          throw new Error(result);
        }
      }
    } catch (err) {
      toast.error(t('toast.failedOpenFolder') + ': ' + String(err));
    }
  }, [t]);

  const handleOpenSkillFolder = useCallback(async (skill: Skill) => {
    try {
      const result = await hostApiFetch<{ success: boolean; error?: string }>('/api/clawhub/open-path', {
        method: 'POST',
        body: JSON.stringify({
          skillKey: skill.id,
          slug: skill.slug,
          baseDir: skill.baseDir,
        }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to open folder');
      }
    } catch (err) {
      toast.error(t('toast.failedOpenActualFolder') + ': ' + String(err));
    }
  }, [t]);

  const navigate = useNavigate();

  const handleCreateSkill = useCallback(async () => {
    // 设置预填充输入文本
    const createSkillMessage = `@skill-creator 请帮我创建一个可以实现「……」的skill`;
    useChatStore.getState().setPrefilledInput(createSkillMessage);
    // 创建新对话
    useChatStore.getState().newSession();
    // 跳转到聊天页面
    navigate('/');
  }, [navigate]);

  const [skillsDirPath, setSkillsDirPath] = useState('~/.openclaw/skills');

  useEffect(() => {
    invokeIpc<string>('openclaw:getSkillsDir')
      .then((dir) => setSkillsDirPath(dir as string))
      .catch(console.error);
  }, []);

  useEffect(() => {
    if (activeTab !== 'market') return;
    const sort = sortOrder === 'desc' ? `-${sortBy}` : sortBy;
    void searchSkills(installQuery.trim(), selectedType, sort);
  }, [activeTab, selectedType, sortBy, sortOrder, installQuery, searchSkills]);

  const handleSearch = useCallback(() => {
    // 服务器端规则：带-号是降序，不带是升序
    const sort = sortOrder === 'desc' ? `-${sortBy}` : sortBy;
    searchSkills(installQuery.trim(), selectedType, sort);
  }, [installQuery, selectedType, sortBy, sortOrder, searchSkills]);

  const handleInstallQueryKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  }, [handleSearch]);

  const handleInstall = useCallback(async (slug: string) => {
    try {
      const currentScroll = listRef.current?.scrollTop || 0;

      const packageSlug = await installSkill(slug);
      await fetchSkills();

      if (packageSlug) {
        const installed = useSkillsStore.getState().skills.find(
          (skill) => skill.slug === packageSlug || skill.id === packageSlug,
        );
        await enableSkill(installed?.id || packageSlug);
      } else {
        await enableSkill(slug);
      }

      if (activeTab === 'market') {
        const sort = sortOrder === 'desc' ? `-${sortBy}` : sortBy;
        await searchSkills(installQuery.trim(), selectedType, sort);
      }

      setTimeout(() => {
        listRef.current?.scrollTo({ top: currentScroll, behavior: 'smooth' });
      }, 0);

      toast.success(t('toast.installed'));
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (INSTALL_ERROR_CODES.has(errorMessage)) {
        toast.error(t(`toast.${errorMessage}`, { path: skillsDirPath }), { duration: 10000 });
      } else {
        toast.error(t('toast.failedInstall') + ': ' + errorMessage);
      }
    }
  }, [installSkill, enableSkill, fetchSkills, searchSkills, activeTab, installQuery, selectedType, sortBy, sortOrder, t, skillsDirPath]);

  const handleUninstall = useCallback(async (slug: string) => {
    try {
      // 保存当前滚动位置
      const currentScroll = listRef.current?.scrollTop || 0;
      
      await uninstallSkill(slug);
      await hydrateUiStateFromDisk();
      await flushUiStateSync().catch(() => undefined);
      await fetchSkills();

      // 关闭技能详情弹窗
      setSelectedSkill(null);
      
      // 恢复滚动位置
      setTimeout(() => {
        if (listRef.current) {
          listRef.current.scrollTop = currentScroll;
        }
      }, 0);
      
      toast.success(t('toast.uninstalled'));
    } catch (err) {
      toast.error(t('toast.failedUninstall') + ': ' + String(err));
    }
  }, [uninstallSkill, fetchSkills, t]);

  const showInitialLoading = loading && activeTab === 'mine' && safeSkills.length === 0;
  const showMineLoading = useMinLoading(showInitialLoading);

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

        {/* Header */}
        <div className="flex flex-row items-start justify-between mb-5 shrink-0 gap-4">
          <div>
            <h1 className="text-[20px] font-bold text-foreground leading-tight">
              {t('title')}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1">
              {t('subtitle')}
            </p>
          </div>

          <div className="relative shrink-0 w-[132px]" ref={addMenuRef}>
            <button
              onClick={() => setAddMenuOpen((open) => !open)}
              className="w-full bg-[#FF922B] hover:bg-[#FF6A00] transition-colors text-white text-[13px] font-medium h-8 px-3 rounded-lg flex items-center justify-center gap-1.5 shadow-sm shadow-[#FF922B]/25"
            >
              <Plus className="h-4 w-4" />
              {t('actions.addSkill')}
              <ChevronDown
                className={cn(
                  'h-3.5 w-3.5 opacity-90 transition-transform',
                  addMenuOpen && 'rotate-180',
                )}
              />
            </button>
            {addMenuOpen && (
              <div className="absolute right-0 top-full mt-1.5 w-full rounded-lg border border-black/10 dark:border-white/10 bg-white dark:bg-card shadow-lg shadow-black/10 overflow-hidden z-20 py-1">
                <button
                  onClick={() => {
                    setUploadSkillOpen(true);
                    setAddMenuOpen(false);
                  }}
                  className="group w-full flex items-center gap-2 px-3.5 py-2 text-[13px] text-foreground hover:bg-[#FFF2E5] hover:text-[#FF922B] dark:hover:bg-[#FF922B]/15 transition-colors text-left"
                >
                  <Upload className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[#FF922B] shrink-0 transition-colors" />
                  {t('actions.uploadSkill')}
                </button>
                <button
                  onClick={() => {
                    void handleCreateSkill();
                    setAddMenuOpen(false);
                  }}
                  className="group w-full flex items-center gap-2 px-3.5 py-2 text-[13px] text-foreground hover:bg-[#FFF2E5] hover:text-[#FF922B] dark:hover:bg-[#FF922B]/15 transition-colors text-left"
                >
                  <Plus className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[#FF922B] shrink-0 transition-colors" />
                  {t('actions.createSkill')}
                </button>
                <div className="my-1 mx-3 h-px bg-black/5 dark:bg-white/10" />
                <button
                  onClick={() => {
                    void bulkToggleVisible(true);
                    setAddMenuOpen(false);
                  }}
                  className="group w-full flex items-center gap-2 px-3.5 py-2 text-[13px] text-foreground hover:bg-[#FFF2E5] hover:text-[#FF922B] dark:hover:bg-[#FF922B]/15 transition-colors text-left"
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[#FF922B] shrink-0 transition-colors" />
                  {t('actions.enableVisible')}
                </button>
                <button
                  onClick={() => {
                    void bulkToggleVisible(false);
                    setAddMenuOpen(false);
                  }}
                  className="group w-full flex items-center gap-2 px-3.5 py-2 text-[13px] text-foreground hover:bg-[#FFF2E5] hover:text-[#FF922B] dark:hover:bg-[#FF922B]/15 transition-colors text-left"
                >
                  <Ban className="h-3.5 w-3.5 text-muted-foreground group-hover:text-[#FF922B] shrink-0 transition-colors" />
                  {t('actions.disableVisible')}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Top tabs + filter/search row */}
        <div className="flex items-center justify-between gap-6 mb-4 shrink-0">
          <div className="flex items-center gap-6">
            {([
              { key: 'mine', label: t('tabs.mine', { defaultValue: '我的技能' }) },
              { key: 'market', label: t('tabs.market', { defaultValue: '技能广场' }) },
            ] as const).map(({ key, label }) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
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
                  placeholder={t('search')}
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
                onClick={() => void fetchSkills()}
                disabled={loading}
                className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
                title={t('refresh')}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-end gap-4 shrink-0 flex-1">
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-0 rounded">
                  {(['download_count', 'update_time'] as const).map((sort, index) => {
                    const labels = {
                      download_count: '下载量',
                      update_time: '时间',
                    };
                    const isSelected = sortBy === sort;
                    return (
                      <button
                        key={sort}
                        onClick={() => {
                          if (sortBy === sort) {
                            setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
                          } else {
                            setSortBy(sort);
                            setSortOrder('desc');
                          }
                        }}
                        className={cn(
                          'px-3 py-1 text-[12.5px] transition-all flex items-center justify-center gap-1',
                          index === 0 && 'rounded-l',
                          index === 1 && 'rounded-r',
                          isSelected
                            ? 'bg-[#FFF2E5] text-[#FF922B] font-medium dark:bg-[#FF922B]/15'
                            : 'bg-gray-100 text-gray-500 hover:bg-gray-200',
                        )}
                      >
                        {labels[sort]}
                        {isSelected && sortOrder === 'desc' && (
                          <ChevronDown className="h-3 w-3" />
                        )}
                        {isSelected && sortOrder === 'asc' && (
                          <ChevronUp className="h-3 w-3" />
                        )}
                      </button>
                    );
                  })}
                </div>

                <div className="flex items-center gap-0 rounded">
                  {(['all', 'installed', 'uninstalled'] as const).map((filter, index) => {
                    const counts = {
                      all: searchResults.length,
                      installed: installedMarketplaceCount,
                      uninstalled: uninstalledMarketplaceCount,
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
                    placeholder={t('search')}
                    value={installQuery}
                    onChange={(e) => setInstallQuery(e.target.value)}
                    onKeyDown={handleInstallQueryKeyDown}
                    className="ml-2 bg-transparent outline-none w-full text-[13px] text-foreground placeholder:text-[#FF922B]/80"
                  />
                  {installQuery && (
                    <button
                      type="button"
                      onClick={() => {
                        setInstallQuery('');
                        searchSkills('', selectedType);
                      }}
                      className="text-[#FF922B]/70 hover:text-[#FF922B] shrink-0 ml-1"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleSearch}
                  className="h-8 w-8 rounded-full text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
                  title={t('searchButton')}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', searching && 'animate-spin')} />
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Gateway Warning */}
        {showGatewayWarning && (
          <div className="mb-4 p-3.5 rounded-xl border border-yellow-500/40 bg-yellow-500/10 flex items-center gap-3 shrink-0">
            <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0" />
            <span className="text-yellow-700 dark:text-yellow-400 text-[13px] font-medium">
              {t('gatewayWarning')}
            </span>
          </div>
        )}

        {/* Filter chips for mine tab */}
        {activeTab === 'mine' && (
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4 shrink-0">
            <div className="flex items-center flex-wrap gap-2">
              {([
                { key: 'all', label: '全部', count: sourceStats.all },
                { key: 'built-in', label: '内置', count: sourceStats.builtIn },
                { key: 'marketplace', label: '技能广场', count: sourceStats.marketplace },
              ] as const).map(({ key, label, count }) => {
                const isActive = selectedSource === key;
                const filterKey = key === 'built-in' ? 'builtIn' : key;
                return (
                  <button
                    key={key}
                    onClick={() => setSelectedSource(key)}
                    className={cn(
                      'px-3.5 py-1 rounded-full text-[13px] transition-all',
                      isActive
                        ? 'bg-[#FFF2E5] text-[#FF922B] font-medium dark:bg-[#FF922B]/15'
                        : 'text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5',
                    )}
                  >
                    {t(`filter.${filterKey}`, { count, defaultValue: `${label} (${count})` })}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Filter chips for market tab - only category options remain here */}
        {activeTab === 'market' && (
          <div className="flex flex-wrap gap-2 mb-4 shrink-0">
            {marketplaceCategoryOptions.map(({ key, label }) => {
              const isActive = selectedType === key;
              return (
                <button
                  key={key || 'all'}
                  onClick={() => setSelectedType(key)}
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

        {/* Content Area */}
        <div ref={listRef} className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
          {error && (
            <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
              <AlertCircle className="h-5 w-5 shrink-0" />
              <span>
                {FETCH_ERROR_CODES.has(error)
                  ? t(`toast.${error}`, { path: skillsDirPath })
                  : error}
              </span>
            </div>
          )}

          {activeTab === 'mine' ? (
            showMineLoading ? (
              <CenteredLoader message={t('loadingMine')} testId="skills-mine-loading" />
            ) : filteredSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                <Puzzle className="h-10 w-10 mb-4 opacity-50" />
                <p>{searchQuery ? t('noSkillsSearch') : t('noSkillsAvailable')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {filteredSkills.map((skill) => (
                  <SkillCard
                    key={skill.baseDir || skill.slug || skill.id}
                    skill={skill}
                    onClick={() => setSelectedSkill(skill)}
                    onToggle={(checked) => handleToggle(skill.id, checked)}
                    t={t}
                    marketplaceMatch={findMarketplaceSkillMatch(skill, marketplaceLookup)}
                  />
                ))}
              </div>
            )
          ) : (
            <>
              {searchError && (
                <div className="mb-4 p-4 rounded-xl border border-destructive/50 bg-destructive/10 text-destructive text-sm font-medium flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 shrink-0" />
                  <span>
                    {SEARCH_ERROR_CODES.has(searchError.replace('Error: ', ''))
                      ? t(`toast.${searchError.replace('Error: ', '')}`, { path: skillsDirPath })
                      : t('marketplace.searchError')}
                  </span>
                </div>
              )}

              {searching && (
                <CenteredLoader message={t('marketplace.searching')} testId="skills-market-loading" />
              )}

              {!searching && visibleMarketplaceSkills.length > 0 && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                  {visibleMarketplaceSkills.map((skill) => {
                    const isInstalled = isMarketplaceSkillInstalled(skill);
                    const marketplaceKey = getMarketplaceSkillKey(skill);
                    const actionKey = skill.slug;
                    const isBusy = !!installing[actionKey];
                    return (
                      <MarketplaceSkillCard
                        key={marketplaceKey}
                        skill={skill}
                        isInstalled={isInstalled}
                        isLoading={isBusy}
                        onInstall={() => handleInstall(skill.slug)}
                        onUninstall={() => handleUninstall(skill.slug)}
                        t={t}
                      />
                    );
                  })}
                </div>
              )}

              {!searching && visibleMarketplaceSkills.length === 0 && !searchError && (
                <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
                  <Package className="h-10 w-10 mb-4 opacity-50" />
                  <p>{installQuery.trim() ? t('marketplace.noResults') : t('marketplace.emptyPrompt')}</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* Skill Detail Dialog */}
      <SkillDetailDialog
        skill={selectedSkill}
        marketplaceMatch={selectedSkill ? findMarketplaceSkillMatch(selectedSkill, marketplaceLookup) : undefined}
        isOpen={!!selectedSkill}
        onClose={() => setSelectedSkill(null)}
        onOpenFolder={handleOpenSkillFolder}
      />

      {/* Upload Skill Dialog */}
      <UploadSkillDialog
        open={uploadSkillOpen}
        onOpenChange={setUploadSkillOpen}
        onUploadComplete={() => {
          // Refresh skills after upload
          void fetchSkills();
        }}
      />
    </div>
  );
}

export default Skills;
