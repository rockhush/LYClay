import { useState, useRef, useEffect, useMemo } from 'react';
import { Sparkles, Check, RefreshCw, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useProviderStore } from '@/stores/providers';
import { useChatStore } from '@/stores/chat';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { buildProviderListItems, type ProviderListItem } from '@/lib/provider-accounts';
import { LY_MINIMAX_PROVIDER_ID, LY_DEEPSEEK_PROVIDER_ID, LY_MIMO_PROVIDER_ID } from '@/lib/providers';

interface ModelPickerProps {
  disabled?: boolean;
}

export function ModelPicker({ disabled = false }: ModelPickerProps) {
  const { t } = useTranslation('chat');
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const { accounts, statuses, vendors, defaultAccountId } = useProviderStore();
  const isStreaming = useChatStore((s) => !s.runAborted && (s.activeRunId !== null || s.sending));
  const setDefaultAccount = useProviderStore((s) => s.setDefaultAccount);
  const isDefaultAccountSwitching = useProviderStore((s) => s.isDefaultAccountSwitching);
  const pendingDefaultAccountId = useProviderStore((s) => s.pendingDefaultAccountId);

  // Build provider list items
  const providerItems = useMemo(() => {
    return buildProviderListItems(accounts, statuses, vendors, defaultAccountId);
  }, [accounts, statuses, vendors, defaultAccountId]);

  // Filter to only configured providers (with credentials)
  const configuredProviders = useMemo(() => {
    return providerItems.filter(item => {
      if (item.account.vendorId === LY_MINIMAX_PROVIDER_ID) return true;
      if (item.account.vendorId === LY_MIMO_PROVIDER_ID) return true;
      if (item.account.vendorId === LY_DEEPSEEK_PROVIDER_ID) return true;
      // Check if provider has configured credentials
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
      }
    };

    if (pickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [pickerOpen]);

  const handleSelectProvider = (item: ProviderListItem) => {
    if (item.account.id === defaultAccountId || isDefaultAccountSwitching) {
      setPickerOpen(false);
      return;
    }

    setPickerOpen(false);
    void (async () => {
      try {
        await setDefaultAccount(item.account.id);
        toast.success(t('composer.modelSwitched', { name: item.vendor?.name || item.account.label }));
      } catch (error) {
        console.error('Failed to switch model:', error);
        toast.error(t('composer.modelSwitchFailed', { error: String(error) }));
      }
    })();
  };

  // Hide if no configured providers
  if (configuredProviders.length === 0) {
    return null;
  }

  // Disable during streaming, model switch, or if already disabled
  const isDisabled = disabled || isStreaming || isDefaultAccountSwitching;

  const effectiveDefaultAccountId = pendingDefaultAccountId ?? defaultAccountId;

  // Current selected provider/model label
  const currentItem = configuredProviders.find((item) => item.account.id === effectiveDefaultAccountId)
    ?? configuredProviders[0];
  const currentLabel = currentItem
    ? currentItem.account.model || currentItem.vendor?.name || currentItem.account.label
    : t('composer.switchModel');

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
        {isDefaultAccountSwitching ? (
          <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin" />
        ) : (
          <Sparkles className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="ml-1.5 truncate text-xs font-medium">{currentLabel}</span>
        <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-60" />
      </Button>

      {pickerOpen && (
        <div className="absolute right-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
          <div className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
            {t('composer.modelPickerTitle')}
          </div>

          <div className="max-h-64 overflow-y-auto">
            {configuredProviders.map((item) => {
              const isSelected = item.account.id === defaultAccountId;
              const vendorName = item.vendor?.name || item.account.label;

              return (
                <button
                  key={item.account.id}
                  disabled={isDefaultAccountSwitching}
                  onClick={() => handleSelectProvider(item)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                    'hover:bg-black/5 dark:hover:bg-white/5',
                    isSelected && 'bg-primary/10 text-primary font-medium'
                  )}
                >
                  <Sparkles className="h-4 w-4 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{vendorName}</div>
                    {item.account.model && (
                      <div className="truncate text-[11px] text-muted-foreground">{item.account.model}</div>
                    )}
                  </div>
                  {isSelected && <Check className="h-4 w-4 shrink-0" />}
                </button>
              );
            })}
          </div>

          <div className="mt-1.5 border-t border-black/5 pt-1.5 dark:border-white/5">
            <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
              <RefreshCw className="h-3 w-3" />
              <span>{t('composer.modelSwitchNote')}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}