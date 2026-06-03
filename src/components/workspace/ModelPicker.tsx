import { useState, useRef, useEffect, useMemo } from 'react';
import { Sparkles, Check, RefreshCw, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useProviderStore } from '@/stores/providers';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { buildProviderListItems, type ProviderListItem } from '@/lib/provider-accounts';
import { LY_AUTO_PROVIDER_ID } from '@/lib/providers';
import {
  formatContextWindowTokens,
  resolveModelPickerCatalog,
  type ModelPickerCatalogEntry,
} from '@/lib/model-picker-catalog';

interface ModelPickerProps {
  disabled?: boolean;
}

function ModelPickerHoverCard({
  catalog,
  modelId,
}: {
  catalog: ModelPickerCatalogEntry;
  modelId?: string;
}) {
  const { t } = useTranslation('chat');
  const contextLabel = formatContextWindowTokens(catalog.contextWindow);
  const features = [
    catalog.supportsImageInput ? t('composer.modelCatalog.featureImageInput') : null,
    catalog.supportsReasoning ? t('composer.modelCatalog.featureReasoning') : null,
    t('composer.modelCatalog.featureLongContext', { context: contextLabel }),
  ].filter(Boolean) as string[];

  return (
    <div className="w-52 shrink-0 rounded-2xl border border-black/10 bg-white p-3 shadow-xl dark:border-white/10 dark:bg-card">
      <p className="text-[14px] font-semibold text-foreground">
        {modelId || t(catalog.titleKey)}
      </p>
      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        {t(catalog.descriptionKey)}
      </p>
      <div className="mt-3 border-t border-black/5 pt-2.5 dark:border-white/5">
        <p className="text-[12px] font-medium text-foreground/80">
          {t('composer.modelCatalog.featuresTitle')}
        </p>
        <ul className="mt-2 space-y-1.5">
          {features.map((feature) => (
            <li key={feature} className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <Check className="h-3.5 w-3.5 shrink-0 text-primary" strokeWidth={2.5} />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function ModelPicker({ disabled = false }: ModelPickerProps) {
  const { t } = useTranslation('chat');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [hoveredAccountId, setHoveredAccountId] = useState<string | null>(null);
  const [switchingSessionModel, setSwitchingSessionModel] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const { accounts, statuses, vendors, defaultAccountId } = useProviderStore();
  const isStreaming = useChatStore((s) => !s.runAborted && (s.activeRunId !== null || s.sending));
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const setCurrentSessionModel = useChatStore((s) => s.setCurrentSessionModel);
  const agents = useAgentsStore((s) => s.agents);
  const defaultModelRef = useAgentsStore((s) => s.defaultModelRef);

  const providerItems = useMemo(() => {
    return buildProviderListItems(accounts, statuses, vendors, defaultAccountId);
  }, [accounts, statuses, vendors, defaultAccountId]);

  const configuredProviders = useMemo(() => {
    return providerItems.filter(item => {
      if (item.account.vendorId === LY_AUTO_PROVIDER_ID) return true;
      if (!item.status) return false;
      if (item.account.authMode === 'oauth_device' ||
          item.account.authMode === 'oauth_browser' ||
          item.account.authMode === 'local') {
        return true;
      }
      return item.status.hasKey ?? false;
    });
  }, [providerItems]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
        setHoveredAccountId(null);
      }
    };

    if (pickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) {
      setHoveredAccountId(null);
    }
  }, [pickerOpen]);

  const handleSelectProvider = (item: ProviderListItem) => {
    const nextModel = item.account.model?.trim();
    if (!nextModel || switchingSessionModel) {
      setPickerOpen(false);
      setHoveredAccountId(null);
      return;
    }

    const currentSessionModel = sessions.find((session) => session.key === currentSessionKey)?.model;
    if (nextModel === currentSessionModel) {
      setPickerOpen(false);
      setHoveredAccountId(null);
      return;
    }

    setPickerOpen(false);
    setHoveredAccountId(null);
    setSwitchingSessionModel(true);
    void (async () => {
      try {
        await setCurrentSessionModel(nextModel);
        toast.success(t('composer.modelSwitched', { name: item.vendor?.name || item.account.label }));
      } catch (error) {
        console.error('Failed to persist session model:', error);
        toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
      } finally {
        setSwitchingSessionModel(false);
      }
    })();
  };

  if (configuredProviders.length === 0) {
    return null;
  }

  const isDisabled = disabled || isStreaming || switchingSessionModel;
  const currentSessionModel = sessions.find((session) => session.key === currentSessionKey)?.model;
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);
  const effectiveModelRef = currentSessionModel || currentAgent?.modelRef || defaultModelRef || undefined;
  const currentItem = configuredProviders.find((item) => item.account.model === effectiveModelRef)
    ?? configuredProviders.find((item) => item.account.id === defaultAccountId)
    ?? configuredProviders[0];
  const currentLabel = effectiveModelRef
    || currentItem?.account.model
    || currentItem?.vendor?.name
    || currentItem?.account.label
    || currentAgent?.modelDisplay
    || defaultModelRef?.split('/').pop()
    || t('composer.switchModel');

  const hoveredItem = configuredProviders.find((item) => item.account.id === hoveredAccountId) ?? null;
  const hoveredCatalog = hoveredItem
    ? resolveModelPickerCatalog(hoveredItem.account.vendorId)
    : null;

  const handlePopupMouseLeave = (event: React.MouseEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setHoveredAccountId(null);
  };

  return (
    <div ref={pickerRef} className="relative shrink-0">
      <Button
        variant="ghost"
        size="sm"
        className={cn(
          'h-8 max-w-[200px] rounded-lg px-2.5 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
          pickerOpen && 'bg-primary/10 text-primary hover:bg-primary/20',
          isDisabled && 'opacity-40 cursor-not-allowed'
        )}
        onClick={() => !isDisabled && setPickerOpen((open) => !open)}
        disabled={isDisabled}
        title={t('composer.switchModel')}
      >
        {switchingSessionModel ? (
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="ml-1.5 truncate text-xs font-medium">{currentLabel}</span>
        <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-60" />
      </Button>

      {pickerOpen && (
        <div
          className="absolute left-0 bottom-full z-20 mb-2"
          onMouseLeave={handlePopupMouseLeave}
        >
          <div className="relative w-56 overflow-visible">
            <div className="overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
              <div className="px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground/80">
                {t('composer.modelPickerTitle')}
              </div>

              <div className="max-h-64 overflow-y-auto">
                {configuredProviders.map((item) => {
                  const isSelected = item.account.model === effectiveModelRef
                    || (!effectiveModelRef && item.account.id === currentItem?.account.id);
                  const isHovered = item.account.id === hoveredAccountId;
                  const vendorName = item.vendor?.name || item.account.label;
                  const modelId = item.account.model?.includes('/')
                    ? item.account.model.split('/').pop()
                    : item.account.model;

                  return (
                    <button
                      key={item.account.id}
                      type="button"
                      disabled={switchingSessionModel}
                      onMouseEnter={() => setHoveredAccountId(item.account.id)}
                      onFocus={() => setHoveredAccountId(item.account.id)}
                      onClick={() => handleSelectProvider(item)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[13px] transition-colors',
                        isSelected
                          ? 'bg-primary/10 text-primary font-medium'
                          : isHovered
                            ? 'bg-[#EFF6FF] text-foreground dark:bg-sky-950/40'
                            : 'text-foreground hover:bg-[#EFF6FF] dark:hover:bg-sky-950/40',
                      )}
                    >
                      <Sparkles className="h-4 w-4 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{vendorName}</div>
                        {modelId && (
                          <div className="truncate text-[11px] text-muted-foreground">{modelId}</div>
                        )}
                      </div>
                      {isSelected && <Check className="h-4 w-4 shrink-0" />}
                    </button>
                  );
                })}
              </div>

              <div className="mt-1 border-t border-black/5 pt-1 dark:border-white/5">
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] text-muted-foreground">
                  <RefreshCw className="h-3 w-3 shrink-0" />
                  <span>{t('composer.modelSwitchNote')}</span>
                </div>
              </div>
            </div>

            {hoveredItem && hoveredCatalog && (
              <div
                className="pointer-events-auto absolute left-full top-0 z-30 ml-2"
                onMouseEnter={() => setHoveredAccountId(hoveredItem.account.id)}
              >
                <ModelPickerHoverCard
                  catalog={hoveredCatalog}
                  modelId={hoveredItem.account.model?.includes('/')
                    ? hoveredItem.account.model.split('/').pop()
                    : hoveredItem.account.model}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
