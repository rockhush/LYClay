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
import { hostApiFetch } from '@/lib/host-api';
import { extractModelIdFromModelRef, findProviderItemByModelRef, resolveAccountModelRefs, type ProviderModelRefOption } from '@/lib/provider-model-ref';
import { LY_AUTO_PROVIDER_ID, type ProviderAccount } from '@/lib/providers';
import {
  formatContextWindowTokens,
  resolveModelPickerCatalog,
  type ModelPickerCatalogEntry,
} from '@/lib/model-picker-catalog';

interface ModelPickerProps {
  disabled?: boolean;
}

type ConfiguredModelOption = ProviderListItem & {
  model: ProviderModelRefOption;
  optionId: string;
};

type DigitalEmployeeModelScope = {
  provider: {
    providerId: string;
    protocol: 'openai-completions';
    baseUrl: string;
  };
  models: Array<string | (Record<string, unknown> & { modelId?: string; id?: string; name?: string })>;
  defaultModel: string | null;
  lastSuccessAt: string | null;
};

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
  const [hoveredOptionId, setHoveredOptionId] = useState<string | null>(null);
  const [switchingSessionModel, setSwitchingSessionModel] = useState(false);
  const [digitalEmployeeModelScope, setDigitalEmployeeModelScope] = useState<DigitalEmployeeModelScope | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const { accounts, statuses, vendors, defaultAccountId } = useProviderStore();
  const isStreaming = useChatStore((s) => !s.runAborted && (s.activeRunId !== null || s.sending));
  const currentAgentId = useChatStore((s) => s.currentAgentId);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessions = useChatStore((s) => s.sessions);
  const setCurrentSessionModel = useChatStore((s) => s.setCurrentSessionModel);
  const agents = useAgentsStore((s) => s.agents);
  const defaultModelRef = useAgentsStore((s) => s.defaultModelRef);
  const currentAgent = agents.find((agent) => agent.id === currentAgentId);

  const providerItems = useMemo(() => {
    return buildProviderListItems(accounts, statuses, vendors, defaultAccountId);
  }, [accounts, statuses, vendors, defaultAccountId]);


  useEffect(() => {
    let cancelled = false;
    const agentId = currentAgent?.isDigitalEmployee ? currentAgent.id : null;
    if (!agentId) {
      setDigitalEmployeeModelScope(null);
      return;
    }

    void hostApiFetch<{ success: boolean; modelScope?: DigitalEmployeeModelScope | null }>(
      `/api/agents/${encodeURIComponent(agentId)}/model-scope`,
    )
      .then((response) => {
        if (!cancelled) setDigitalEmployeeModelScope(response.modelScope ?? null);
      })
      .catch(() => {
        if (!cancelled) setDigitalEmployeeModelScope(null);
      });

    return () => {
      cancelled = true;
    };
  }, [currentAgent?.id, currentAgent?.isDigitalEmployee]);
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


  const digitalEmployeeProviderItem = useMemo<ProviderListItem | null>(() => {
    if (!currentAgent?.isDigitalEmployee || !digitalEmployeeModelScope?.models.length) return null;
    const now = digitalEmployeeModelScope.lastSuccessAt ?? new Date(0).toISOString();
    const runtimeModels = digitalEmployeeModelScope.models.map((model) => {
      if (typeof model === 'string') {
        return { id: model, name: `LY-${model}` };
      }
      const modelId = String(model.modelId ?? model.id ?? '').trim();
      return {
        ...model,
        id: modelId,
        name: typeof model.name === 'string' && model.name.trim() ? model.name : `LY-${modelId}`,
      };
    }).filter((model): model is Record<string, unknown> & { id: string; name: string } => Boolean(model.id));
    const firstModel = runtimeModels[0]?.id;
    if (!firstModel) return null;
    const account: ProviderAccount = {
      id: digitalEmployeeModelScope.provider.providerId,
      vendorId: 'custom',
      label: 'LY-SUB2API',
      authMode: 'api_key',
      baseUrl: digitalEmployeeModelScope.provider.baseUrl,
      apiProtocol: digitalEmployeeModelScope.provider.protocol,
      model: firstModel,
      fallbackModels: runtimeModels.map((model) => model.id),
      runtimeModels,
      enabled: true,
      isDefault: false,
      metadata: {
        managedBy: 'sub2api',
        scope: 'digitalEmployee',
        hiddenInProviderSettings: true,
        lastSuccessAt: digitalEmployeeModelScope.lastSuccessAt ?? undefined,
      },
      createdAt: now,
      updatedAt: now,
    };
    return {
      account,
      vendor: vendors.find((vendor) => vendor.id === 'custom'),
      status: {
        id: account.id,
        name: account.label,
        type: 'custom',
        baseUrl: account.baseUrl,
        apiProtocol: account.apiProtocol,
        model: account.model,
        fallbackModels: account.fallbackModels,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        hasKey: true,
        keyMasked: '••••',
      },
    };
  }, [currentAgent?.isDigitalEmployee, digitalEmployeeModelScope, vendors]);
  const configuredModelOptions = useMemo<ConfiguredModelOption[]>(() => {
    const sourceProviders = digitalEmployeeProviderItem
      ? [digitalEmployeeProviderItem, ...configuredProviders]
      : configuredProviders;
    return sourceProviders.flatMap((item) =>
      resolveAccountModelRefs(item.account).map((model) => ({
        ...item,
        model,
        optionId: `${item.account.id}:${model.modelId}`,
      })),
    );
  }, [configuredProviders, digitalEmployeeProviderItem]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
        setHoveredOptionId(null);
      }
    };

    if (pickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) {
      setHoveredOptionId(null);
    }
  }, [pickerOpen]);

  const handleSelectProvider = (item: ConfiguredModelOption) => {
    if (switchingSessionModel) {
      return;
    }

    const nextModel = item.model.modelRef;
    if (!nextModel) {
      toast.error(t('composer.noModelConfigured', { defaultValue: '该 Provider 未配置模型' }));
      setPickerOpen(false);
      setHoveredOptionId(null);
      return;
    }

    const currentSessionModel = sessions.find((session) => session.key === currentSessionKey)?.model;
    if (nextModel === currentSessionModel) {
      setPickerOpen(false);
      setHoveredOptionId(null);
      return;
    }

    setPickerOpen(false);
    setHoveredOptionId(null);
    setSwitchingSessionModel(true);
    void (async () => {
      try {
        await setCurrentSessionModel(nextModel);
        toast.success(t('composer.modelSwitched', { name: item.model.label || item.vendor?.name || item.account.label }));
      } catch (error) {
        console.error('Failed to persist session model:', error);
        toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
      } finally {
        setSwitchingSessionModel(false);
      }
    })();
  };

  if (configuredModelOptions.length === 0) {
    return null;
  }

  const isDisabled = disabled || isStreaming || switchingSessionModel;
  const currentSessionModel = sessions.find((session) => session.key === currentSessionKey)?.model;
  const effectiveModelRef = currentSessionModel || currentAgent?.modelRef || defaultModelRef || undefined;
  const currentItem = configuredModelOptions.find((item) => item.model.modelRef === effectiveModelRef)
    ?? configuredModelOptions.find((item) => item.account.id === defaultAccountId)
    ?? configuredModelOptions[0];
  const effectiveModelId = effectiveModelRef ? extractModelIdFromModelRef(effectiveModelRef) : undefined;
  const matchedModelOption = configuredModelOptions.find((item) => item.model.modelRef === effectiveModelRef)
    ?? configuredModelOptions.find((item) => item.account.id === currentItem?.account.id && item.model.modelId === effectiveModelId)
    ?? configuredModelOptions.find((item) => item.model.modelId === effectiveModelId);
  const matchedAccount = matchedModelOption ?? findProviderItemByModelRef(configuredProviders, effectiveModelRef);
  const currentLabel = matchedModelOption?.model.label
    || (matchedAccount?.account.metadata?.managedBy === 'sub2api' ? effectiveModelId : undefined)
    || matchedAccount?.account.label
    || matchedAccount?.vendor?.name
    || effectiveModelId
    || effectiveModelRef
    || currentItem?.model.label
    || currentItem?.account.label
    || currentItem?.vendor?.name
    || currentAgent?.modelDisplay
    || defaultModelRef?.split('/').pop()
    || t('composer.switchModel');

  const hoveredItem = configuredModelOptions.find((item) => item.optionId === hoveredOptionId) ?? null;
  const hoveredCatalog = hoveredItem
    ? resolveModelPickerCatalog(hoveredItem.account.vendorId)
    : null;

  const handlePopupMouseLeave = (event: React.MouseEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return;
    }
    setHoveredOptionId(null);
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
                {configuredModelOptions.map((item) => {
                  const isSelected = item.model.modelRef === effectiveModelRef
                    || item.model.modelId === effectiveModelId
                    || (!effectiveModelRef && item.optionId === currentItem?.optionId);
                  const isHovered = item.optionId === hoveredOptionId;
                  const vendorName = item.vendor?.name || item.account.label;
                  const modelId = item.model.modelId;

                  return (
                    <button
                      key={item.optionId}
                      type="button"
                      disabled={switchingSessionModel}
                      onMouseEnter={() => setHoveredOptionId(item.optionId)}
                      onFocus={() => setHoveredOptionId(item.optionId)}
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
                        <div className="truncate font-medium">{item.model.label || vendorName}</div>
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
                onMouseEnter={() => setHoveredOptionId(hoveredItem.optionId)}
              >
                <ModelPickerHoverCard
                  catalog={hoveredCatalog}
                  modelId={hoveredItem.model.modelId}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}