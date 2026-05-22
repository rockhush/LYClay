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
    <div
      data-testid="connectors-page"
      className="flex flex-col -m-6 bg-white dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden"
    >
      <div className="w-full max-w-5xl mx-auto flex flex-col h-full pl-[2em] pt-[2em] pr-8 pb-8">
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
          <Button
            type="button"
            className="h-8 text-[13px] font-medium rounded-lg px-4 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm shadow-[#FF922B]/25 transition-colors shrink-0"
            onClick={() => {
              setConnectorPageTab('custom');
              setDialog('custom');
            }}
          >
            {t('customConnector')}
          </Button>
        </div>

        <div className="mb-5 shrink-0">
          <ConnectorTabs value={connectorPageTab} onChange={setConnectorPageTab} />
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-10 min-h-0 -mr-2">
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
                  <p className="text-[13px] text-muted-foreground">{t('custom.empty')}</p>
                  <Button
                    type="button"
                    className="mt-4 h-8 text-[13px] font-medium rounded-lg px-4 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm shadow-[#FF922B]/25 transition-colors"
                    onClick={() => {
                      setConnectorPageTab('custom');
                      setDialog('custom');
                    }}
                  >
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
        </div>

        <InstallDialog
          mode={dialog}
          onClose={() => setDialog(null)}
          onSaveCustom={handleSaveCustom}
          baseConfig={mcpConfig}
        />
      </div>
    </div>
  );
}
