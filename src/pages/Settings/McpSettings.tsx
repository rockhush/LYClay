/**
 * MCP services list (from OpenClaw mcp.servers) with search and toggles.
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { McpServiceCard } from '@/components/settings/McpServiceCard';
import { useConnectorsStore } from '@/stores/connectors';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { toast } from 'sonner';
import { toUserMessage } from '@/lib/api-client';

export function McpSettings() {
  const { t } = useTranslation('connectors');
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const initialSearch = params.get('search') ?? '';
  const [q, setQ] = useState(initialSearch);
  const [busyName, setBusyName] = useState<string | null>(null);

  const mcpServers = useConnectorsStore((s) => s.mcpServers);
  const mcpServersLoading = useConnectorsStore((s) => s.mcpServersLoading);
  const fetchMcpServers = useConnectorsStore((s) => s.fetchMcpServers);
  const fetchMcpConfig = useConnectorsStore((s) => s.fetchMcpConfig);
  const enableMcpServer = useConnectorsStore((s) => s.enableMcpServer);
  const disableMcpServer = useConnectorsStore((s) => s.disableMcpServer);

  useEffect(() => {
    void fetchMcpServers();
    void fetchMcpConfig();
  }, [fetchMcpServers, fetchMcpConfig]);

  useEffect(() => {
    setQ(initialSearch);
  }, [initialSearch]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return mcpServers;
    return mcpServers.filter((s) => s.name.toLowerCase().includes(needle));
  }, [mcpServers, q]);

  const enabledCount = useMemo(() => mcpServers.filter((s) => s.enabled).length, [mcpServers]);

  const handleToggle = async (name: string, enabled: boolean) => {
    setBusyName(name);
    try {
      if (enabled) await enableMcpServer(name);
      else await disableMcpServer(name);
    } catch (error) {
      toast.error(toUserMessage(error));
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div data-testid="mcp-settings-page" className="mx-auto max-w-3xl space-y-8 pb-16">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-4xl font-serif font-normal tracking-tight text-foreground" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
            {t('mcp.title')}
          </h1>
          <p className="mt-2 text-[15px] text-muted-foreground">{t('mcp.subtitle')}</p>
        </div>
        <Button asChild className="rounded-full shrink-0">
          <Link to="/settings/mcp/config">{t('mcp.editJson')}</Link>
        </Button>
      </div>

      <Input
        data-testid="mcp-settings-search"
        placeholder={t('mcp.searchPlaceholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="max-w-md rounded-full border-black/10 dark:border-white/10"
      />

      <div className="flex items-baseline justify-between text-sm text-muted-foreground">
        <span>{t('mcp.summary', { count: mcpServers.length, enabled: enabledCount })}</span>
      </div>

      {mcpServersLoading ? (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((s) => (
            <McpServiceCard
              key={s.name}
              server={s}
              busy={busyName === s.name}
              onToggle={(on) => void handleToggle(s.name, on)}
              onOpen={() => navigate('/settings/mcp/config')}
            />
          ))}
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground py-8 text-center">{t('mcp.none')}</p>
          )}
        </div>
      )}
    </div>
  );
}
