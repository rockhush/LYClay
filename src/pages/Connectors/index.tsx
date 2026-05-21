/**
 * Connectors management — built-in vs custom MCP (custom entries from OpenClaw mcp.servers)
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useConnectorsStore } from '@/stores/connectors';
import { ConnectorTabs } from './ConnectorTabs';
import { CustomMcpConnectorCard } from './CustomMcpConnectorCard';
import { InstallDialog, type InstallDialogMode } from './InstallDialog';
import { LYCLAW_BUILTIN_MCP_KEYS } from '@/lib/mcp-builtins';
import { toUserMessage } from '@/lib/api-client';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import type { McpConfigFile } from '@/types/connector';

export function Connectors() {
  const { t } = useTranslation('connectors');
  const connectorPageTab = useConnectorsStore((s) => s.connectorPageTab);
  const setConnectorPageTab = useConnectorsStore((s) => s.setConnectorPageTab);
  const mcpServers = useConnectorsStore((s) => s.mcpServers);
  const mcpServersLoading = useConnectorsStore((s) => s.mcpServersLoading);
  const mcpServersError = useConnectorsStore((s) => s.mcpServersError);
  const fetchMcpServers = useConnectorsStore((s) => s.fetchMcpServers);
  const fetchMcpConfig = useConnectorsStore((s) => s.fetchMcpConfig);
  const saveMcpConfig = useConnectorsStore((s) => s.saveMcpConfig);
  const validateMcpConfig = useConnectorsStore((s) => s.validateMcpConfig);
  const mcpConfig = useConnectorsStore((s) => s.mcpConfig);

  const [dialog, setDialog] = useState<InstallDialogMode>(null);

  useEffect(() => {
    void fetchMcpServers();
    void fetchMcpConfig();
  }, [fetchMcpServers, fetchMcpConfig]);

  useEffect(() => {
    if (mcpServersError) toast.error(mcpServersError);
  }, [mcpServersError]);

  const customServers = useMemo(
    () => mcpServers.filter((s) => !LYCLAW_BUILTIN_MCP_KEYS.has(s.name)),
    [mcpServers],
  );

  const handleSaveCustom = async (config: McpConfigFile) => {
    const v = await validateMcpConfig(config);
    if (!v.valid) {
      toast.error(v.errors.join('\n'));
      throw new Error('validation');
    }
    try {
      await saveMcpConfig(config);
      toast.success(t('toast.customSaved'));
    } catch (error) {
      toast.error(toUserMessage(error));
      throw error;
    }
  };

  return (
    <div data-testid="connectors-page" className="mx-auto max-w-5xl space-y-8 pb-16">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-4xl font-serif font-normal tracking-tight text-foreground" style={{ fontFamily: 'Georgia, Cambria, "Times New Roman", Times, serif' }}>
            {t('title')}
          </h1>
          <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
            {t('subtitle')}
          </p>
        </div>
        <Button
          type="button"
          className="rounded-full shrink-0"
          onClick={() => {
            setConnectorPageTab('custom');
            setDialog('custom');
          }}
        >
          {t('customConnector')}
        </Button>
      </div>

      <ConnectorTabs value={connectorPageTab} onChange={setConnectorPageTab} />

      {mcpServersLoading && (
        <div className="flex justify-center py-12">
          <LoadingSpinner />
        </div>
      )}

      {!mcpServersLoading && connectorPageTab === 'custom' && (
        <div className="space-y-4">
          {customServers.length === 0 ? (
            <div
              data-testid="connectors-custom-empty"
              className="rounded-2xl border border-dashed border-black/15 bg-black/[0.02] px-8 py-16 text-center dark:border-white/15 dark:bg-white/[0.03]"
            >
              <p className="text-muted-foreground">{t('custom.empty')}</p>
              <Button type="button" className="mt-4 rounded-full" variant="secondary" onClick={() => { setConnectorPageTab('custom'); setDialog('custom'); }}>
                {t('custom.emptyCta')}
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4">
              {customServers.map((s) => (
                <CustomMcpConnectorCard key={s.name} server={s} />
              ))}
            </div>
          )}
        </div>
      )}

      <InstallDialog
        mode={dialog}
        onClose={() => setDialog(null)}
        onSaveCustom={handleSaveCustom}
        baseConfig={mcpConfig}
      />
    </div>
  );
}
