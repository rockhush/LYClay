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
    <div className="inline-flex items-center gap-1 rounded-lg bg-transparent p-1">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-testid={tab.id === 'builtIn' ? 'connectors-tab-builtin' : 'connectors-tab-custom'}
          onClick={() => onChange(tab.id)}
          className={cn(
            'h-7 px-3 rounded-md text-[12.5px] font-medium transition-colors',
            value === tab.id
              ? 'bg-[#FFF2E5] text-[#FF922B] dark:bg-[#FF922B]/15'
              : 'bg-transparent text-muted-foreground hover:bg-black/5 dark:hover:bg-white/5',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
