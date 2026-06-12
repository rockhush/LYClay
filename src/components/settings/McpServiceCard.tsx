import { ChevronRight } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { McpServerStatus } from '@/types/connector';
import { useTranslation } from 'react-i18next';

interface McpServiceCardProps {
  server: McpServerStatus;
  busy?: boolean;
  onToggle: (enabled: boolean) => void;
  onOpen?: () => void;
}

export function McpServiceCard({ server, busy, onToggle, onOpen }: McpServiceCardProps) {
  const { t } = useTranslation('connectors');
  const subtitle = server.totalTools > 0
    ? t('mcp.toolsLine', { used: server.toolCount, total: server.totalTools })
    : t('mcp.toolsUnknown');

  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-2xl border border-black/10 bg-white/80 px-4 py-3 shadow-sm',
        'dark:border-white/10 dark:bg-card/80',
      )}
    >
      <button
        type="button"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-black/10 text-muted-foreground hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
        onClick={() => onOpen?.()}
        title={t('mcp.openJson')}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{server.name}</span>
          <span
            className={cn(
              'inline-flex h-2 w-2 shrink-0 rounded-full',
              server.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30',
            )}
          />
        </div>
        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      </div>
      <Switch
        checked={server.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
      />
    </div>
  );
}
