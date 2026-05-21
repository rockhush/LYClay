import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { McpServerStatus } from '@/types/connector';
import { useConnectorsStore } from '@/stores/connectors';
import { toast } from 'sonner';
import { toUserMessage } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';

export function CustomMcpConnectorCard({
  server,
}: {
  server: McpServerStatus;
}) {
  const { t } = useTranslation('connectors');
  const fetchMcpServerTools = useConnectorsStore((s) => s.fetchMcpServerTools);
  const denyMcpTool = useConnectorsStore((s) => s.denyMcpTool);
  const undenyMcpTool = useConnectorsStore((s) => s.undenyMcpTool);
  const deleteMcpServer = useConnectorsStore((s) => s.deleteMcpServer);
  const enableMcpServer = useConnectorsStore((s) => s.enableMcpServer);
  const disableMcpServer = useConnectorsStore((s) => s.disableMcpServer);

  const [tools, setTools] = useState<string[]>([]);
  const [denied, setDenied] = useState<string[]>(server.deniedTools ?? []);
  const [loading, setLoading] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchMcpServerTools(server.name);
      setTools(r.tools);
      setDenied(r.denied);
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setLoading(false);
    }
  }, [fetchMcpServerTools, server.name]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setDenied(server.deniedTools ?? []);
  }, [server.deniedTools]);

  const enabledCount = tools.filter((x) => !denied.includes(x)).length;
  const total = tools.length;

  const handleToggleServer = async (on: boolean) => {
    setToggleBusy(true);
    try {
      if (on) await enableMcpServer(server.name);
      else await disableMcpServer(server.name);
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setToggleBusy(false);
    }
  };

  const handleToolClick = async (tool: string) => {
    const isDenied = denied.includes(tool);
    const previousDenied = denied;
    const nextDenied = isDenied ? denied.filter((x) => x !== tool) : [...denied, tool];
    setDenied(nextDenied);
    try {
      if (isDenied) await undenyMcpTool(server.name, tool);
      else await denyMcpTool(server.name, tool);
    } catch (error) {
      setDenied(previousDenied);
      toast.error(toUserMessage(error));
    }
  };

  const summary = [server.type, server.url || server.command].filter(Boolean).join(' · ') || 'MCP';

  return (
    <>
      <Card
        data-testid="connectors-custom-card"
        data-server-name={server.name}
        className="w-full overflow-hidden border-black/10 bg-white/80 shadow-sm dark:border-white/10 dark:bg-card/80"
      >
        <CardHeader className="pb-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <span className="text-2xl shrink-0" aria-hidden>🔌</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle className="text-lg font-semibold tracking-tight truncate">{server.name}</CardTitle>
                  <span
                    className={cn(
                      'inline-flex h-2 w-2 shrink-0 rounded-full',
                      server.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40',
                    )}
                  />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {total > 0
                    ? t('customCard.toolsEnabledLine', { enabled: enabledCount, total })
                    : loading
                      ? t('customCard.loadingTools')
                      : t('customCard.toolsUnknownShort')}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 rounded-full"
                    title={t('customCard.refresh')}
                    onClick={() => void load()}
                    disabled={loading}
                  >
                    <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>{t('customCard.refresh')}</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 rounded-full text-destructive hover:text-destructive"
                    title={t('customCard.deleteServer')}
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>{t('customCard.deleteServer')}</p></TooltipContent>
              </Tooltip>
              <div className="flex items-center gap-2 pl-1">
                <span className="whitespace-nowrap text-xs text-muted-foreground">{t('customCard.toggle')}</span>
                <Switch
                  checked={server.enabled}
                  disabled={toggleBusy}
                  onCheckedChange={(v) => void handleToggleServer(v)}
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <CardDescription className="break-all text-sm leading-relaxed">{summary}</CardDescription>
          {!loading && tools.length === 0 && (
            <p className="text-xs text-muted-foreground">{t('customCard.emptyToolsHint')}</p>
          )}
          {tools.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {tools.map((tool) => {
                const isDenied = denied.includes(tool);
                return (
                  <button
                    key={tool}
                    type="button"
                    onClick={() => void handleToolClick(tool)}
                    title={isDenied ? t('customCard.toolClickRestore') : t('customCard.toolClickDisable')}
                    className={cn(
                      'max-w-full truncate rounded-full border px-2.5 py-1 text-left text-xs font-medium transition-colors',
                      isDenied
                        ? 'border-black/10 bg-black/5 text-muted-foreground line-through dark:border-white/10 dark:bg-white/5'
                        : 'border-black/10 bg-black/[0.04] hover:bg-black/10 dark:border-white/15 dark:bg-white/10 dark:hover:bg-white/15',
                    )}
                  >
                    {tool}
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={confirmDelete}
        title={t('customCard.deleteConfirmTitle', { name: server.name })}
        message={t('customCard.deleteConfirmMessage')}
        confirmLabel={t('customCard.deleteConfirm')}
        cancelLabel={t('customCard.cancel')}
        variant="destructive"
        onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => {
          try {
            await deleteMcpServer(server.name);
            toast.success(t('customCard.deletedServer'));
            setConfirmDelete(false);
          } catch (error) {
            toast.error(toUserMessage(error));
          }
        }}
      />
    </>
  );
}
