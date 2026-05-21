import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import type { ConnectorPageTab } from '@/stores/connectors';

interface ConnectorTabsProps {
  value: ConnectorPageTab;
  onChange: (tab: ConnectorPageTab) => void;
}

export function ConnectorTabs({ value, onChange }: ConnectorTabsProps) {
  const { t } = useTranslation('connectors');
  const tabs: { id: ConnectorPageTab; label: string }[] = [
    { id: 'builtIn', label: t('tabs.builtIn') },
    { id: 'custom', label: t('tabs.custom') },
  ];
  return (
    <div className="inline-flex rounded-full border border-black/10 bg-black/[0.03] p-1 dark:border-white/10 dark:bg-white/5">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-testid={tab.id === 'builtIn' ? 'connectors-tab-builtin' : 'connectors-tab-custom'}
          onClick={() => onChange(tab.id)}
          className={cn(
            'rounded-full px-4 py-1.5 text-sm font-medium transition-colors',
            value === tab.id
              ? 'bg-[#FF7B00] text-white shadow-sm dark:bg-white/15 dark:text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
