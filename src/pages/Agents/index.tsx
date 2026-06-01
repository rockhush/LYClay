import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Bot, Check, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { Switch } from '@/components/ui/switch';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { useAgentsStore } from '@/stores/agents';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { hostApiFetch } from '@/lib/host-api';
import { subscribeHostEvent } from '@/lib/host-events';
import { CHANNEL_ICONS, CHANNEL_NAMES, type ChannelType } from '@/types/channel';
import type { AgentSummary } from '@/types/agent';
import type { ProviderAccount, ProviderVendorInfo, ProviderWithKeyInfo } from '@/lib/providers';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import telegramIcon from '@/assets/channels/telegram.svg';
import discordIcon from '@/assets/channels/discord.svg';
import whatsappIcon from '@/assets/channels/whatsapp.svg';
import wechatIcon from '@/assets/channels/wechat.svg';
import dingtalkIcon from '@/assets/channels/dingtalk.svg';
import feishuIcon from '@/assets/channels/feishu.svg';
import wecomIcon from '@/assets/channels/wecom.svg';
import qqIcon from '@/assets/channels/qq.svg';

interface ChannelAccountItem {
  accountId: string;
  name: string;
  configured: boolean;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  lastError?: string;
  isDefault: boolean;
  agentId?: string;
}

interface ChannelGroupItem {
  channelType: string;
  defaultAccountId: string;
  status: 'connected' | 'connecting' | 'disconnected' | 'error';
  accounts: ChannelAccountItem[];
}

interface RuntimeProviderOption {
  runtimeProviderKey: string;
  accountId: string;
  label: string;
  modelIdPlaceholder?: string;
  configuredModelId?: string;
}

function resolveRuntimeProviderKey(account: ProviderAccount): string {
  if (account.authMode === 'oauth_browser') {
    if (account.vendorId === 'google') return 'google-gemini-cli';
    if (account.vendorId === 'openai') return 'openai-codex';
  }

  if (account.vendorId === 'custom' || account.vendorId === 'ollama') {
    const suffix = account.id.replace(/-/g, '').slice(0, 8);
    return `${account.vendorId}-${suffix}`;
  }

  if (account.vendorId === 'minimax-portal-cn') {
    return 'minimax-portal';
  }

  return account.vendorId;
}

function splitModelRef(modelRef: string | null | undefined): { providerKey: string; modelId: string } | null {
  const value = (modelRef || '').trim();
  if (!value) return null;
  const separatorIndex = value.indexOf('/');
  if (separatorIndex <= 0 || separatorIndex >= value.length - 1) return null;
  return {
    providerKey: value.slice(0, separatorIndex),
    modelId: value.slice(separatorIndex + 1),
  };
}

function hasConfiguredProviderCredentials(
  account: ProviderAccount,
  statusById: Map<string, ProviderWithKeyInfo>,
): boolean {
  if (account.authMode === 'oauth_device' || account.authMode === 'oauth_browser' || account.authMode === 'local') {
    return true;
  }
  return statusById.get(account.id)?.hasKey ?? false;
}

export function Agents() {
  const { t } = useTranslation('agents');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const refreshProviderSnapshot = useProviderStore((state) => state.refreshProviderSnapshot);
  const lastGatewayStateRef = useRef(gatewayStatus.state);
  const {
    agents,
    loading,
    error,
    fetchAgents,
    createAgent,
    deleteAgent,
  } = useAgentsStore();
  const [channelGroups, setChannelGroups] = useState<ChannelGroupItem[]>([]);
  const [hasCompletedInitialLoad, setHasCompletedInitialLoad] = useState(() => agents.length > 0);

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [agentToDelete, setAgentToDelete] = useState<AgentSummary | null>(null);

  const fetchChannelAccounts = useCallback(async () => {
    try {
      const response = await hostApiFetch<{ success: boolean; channels?: ChannelGroupItem[] }>('/api/channels/accounts');
      setChannelGroups(response.channels || []);
    } catch {
      // Keep the last rendered snapshot when channel account refresh fails.
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void Promise.all([fetchAgents(), fetchChannelAccounts(), refreshProviderSnapshot()]).finally(() => {
      if (mounted) {
        setHasCompletedInitialLoad(true);
      }
    });
    return () => {
      mounted = false;
    };
  }, [fetchAgents, fetchChannelAccounts, refreshProviderSnapshot]);

  useEffect(() => {
    const unsubscribe = subscribeHostEvent('gateway:channel-status', () => {
      void fetchChannelAccounts();
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchChannelAccounts]);

  useEffect(() => {
    const previousGatewayState = lastGatewayStateRef.current;
    lastGatewayStateRef.current = gatewayStatus.state;

    if (previousGatewayState !== 'running' && gatewayStatus.state === 'running') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      void fetchChannelAccounts();
    }
  }, [fetchChannelAccounts, gatewayStatus.state]);

  const activeAgent = useMemo(
    () => agents.find((agent) => agent.id === activeAgentId) ?? null,
    [activeAgentId, agents],
  );

  const visibleAgents = agents;
  const visibleChannelGroups = channelGroups;
  const isUsingStableValue = loading && hasCompletedInitialLoad;
  const handleRefresh = () => {
    void Promise.all([fetchAgents(), fetchChannelAccounts()]);
  };

  if (loading && !hasCompletedInitialLoad) {
    return (
      <div className="flex flex-col -m-6 dark:bg-background min-h-[calc(100vh-2.5rem)] items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div data-testid="agents-page" className="flex flex-col -m-6 dark:bg-background h-[calc(100vh-2.5rem)] overflow-hidden">
      <div className="w-full max-w-6xl mx-auto flex flex-col h-full px-8 py-8">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-6 shrink-0 gap-3">
          <div className="min-w-0">
            <h1 className="text-[20px] font-bold text-foreground leading-tight">
              {t('title')}
            </h1>
            <p className="text-[13px] text-muted-foreground mt-1">{t('subtitle')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              onClick={handleRefresh}
              className="h-8 text-[13px] font-medium rounded-lg px-3 border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80 hover:text-foreground transition-colors"
            >
              <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', isUsingStableValue && 'animate-spin')} />
              {t('refresh')}
            </Button>
            <Button
              onClick={() => setShowAddDialog(true)}
              className="h-8 text-[13px] font-medium rounded-lg px-3 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm"
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              {t('addAgent')}
            </Button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pr-2 pb-6 min-h-0 -mr-2">
          {gatewayStatus.state !== 'running' && (
            <div className="mb-4 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 flex items-center gap-3">
              <AlertCircle className="h-4 w-4 text-yellow-600 dark:text-yellow-400" />
              <span className="text-yellow-700 dark:text-yellow-400 text-[13px] font-medium">
                {t('gatewayWarning')}
              </span>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 rounded-lg border border-destructive/50 bg-destructive/10 flex items-center gap-3">
              <AlertCircle className="h-4 w-4 text-destructive" />
              <span className="text-destructive text-[13px] font-medium">
                {error}
              </span>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {visibleAgents.map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                channelGroups={visibleChannelGroups}
                onOpenSettings={() => setActiveAgentId(agent.id)}
                onDelete={() => setAgentToDelete(agent)}
              />
            ))}
          </div>
        </div>
      </div>

      {showAddDialog && (
        <AddAgentDialog
          onClose={() => setShowAddDialog(false)}
          onCreate={async (name, options) => {
            await createAgent(name, options);
            setShowAddDialog(false);
            toast.success(t('toast.agentCreated'));
          }}
        />
      )}

      {activeAgent && (
        <AgentSettingsModal
          agent={activeAgent}
          channelGroups={visibleChannelGroups}
          onClose={() => setActiveAgentId(null)}
        />
      )}

      <ConfirmDialog
        open={!!agentToDelete}
        title={t('deleteDialog.title')}
        message={agentToDelete ? t('deleteDialog.message', { name: agentToDelete.name }) : ''}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!agentToDelete) return;
          try {
            await deleteAgent(agentToDelete.id);
            const deletedId = agentToDelete.id;
            setAgentToDelete(null);
            if (activeAgentId === deletedId) {
              setActiveAgentId(null);
            }
            toast.success(t('toast.agentDeleted'));
          } catch (error) {
            toast.error(t('toast.agentDeleteFailed', { error: String(error) }));
          }
        }}
        onCancel={() => setAgentToDelete(null)}
      />
    </div>
  );
}

function AgentCard({
  agent,
  channelGroups,
  onOpenSettings,
  onDelete,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onOpenSettings: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation('agents');
  const boundChannelAccounts = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => {
        const channelName = CHANNEL_NAMES[group.channelType as ChannelType] || group.channelType;
        const accountLabel =
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId;
        return `${channelName} · ${accountLabel}`;
      }),
  );
  const channelsText = boundChannelAccounts.length > 0
    ? boundChannelAccounts.join(', ')
    : t('none');

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-1.5 p-4 rounded-xl border transition-colors',
        'bg-white dark:bg-card border-black/[0.06] dark:border-white/10',
        'hover:bg-[#FFF7EC] dark:hover:bg-white/[0.04] hover:border-[#FFD79A]/60',
        agent.isDefault && 'bg-[#FFFBF3] dark:bg-white/[0.04] border-[#FFE4B5]/60 dark:border-white/10',
      )}
    >
      <div className="flex items-center gap-2">
        <div className="h-5 w-5 shrink-0 flex items-center justify-center rounded-md bg-black/5 dark:bg-white/10">
          <Bot className="h-3 w-3 text-foreground/70" />
        </div>
        <h2 className="text-[14px] font-semibold text-foreground truncate flex-1">{agent.name}</h2>
        {agent.isDefault && (
          <Badge
            variant="secondary"
            className="hidden xl:inline-flex items-center gap-0.5 text-[10px] font-medium px-1.5 py-0 h-[18px] rounded-md bg-[#FF922B]/10 border-0 text-[#FF6A00] dark:bg-primary/15 dark:text-primary"
          >
            <Check className="h-2.5 w-2.5" />
            {t('defaultBadge')}
          </Badge>
        )}
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-[#FF6A00] hover:bg-[#FF922B]/10 hover:text-[#FF6A00] dark:text-primary dark:hover:bg-primary/15 transition-colors"
            onClick={onOpenSettings}
            title={t('settings')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          {!agent.isDefault && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-[#FF6A00] hover:bg-[#FF922B]/10 hover:text-[#FF6A00] dark:text-primary dark:hover:bg-primary/15 transition-colors"
              onClick={onDelete}
              title={t('deleteAgent')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          <Switch
            checked={agent.isDefault}
            disabled
            className="ml-1 origin-right scale-[0.75] cursor-default disabled:opacity-100"
            aria-label={t('defaultBadge')}
            tabIndex={-1}
          />
        </div>
      </div>

      <p className="text-[12px] text-muted-foreground truncate pl-7">
        <span>
          {t('modelLine', {
            model: agent.modelDisplay,
            suffix: agent.inheritedModel ? ` (${t('inherited')})` : '',
          })}
        </span>
        <span className="mx-2 text-muted-foreground/40">|</span>
        <span>{t('channelsLine', { channels: channelsText })}</span>
      </p>
    </div>
  );
}

const inputClasses = 'h-9 rounded-lg text-[13px] bg-white dark:bg-muted border-black/10 dark:border-white/10 focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[#FFD79A] transition-colors text-foreground placeholder:text-foreground/40';
const selectClasses = 'h-9 w-full rounded-lg text-[13px] bg-white dark:bg-muted border border-black/10 dark:border-white/10 px-3 text-foreground focus-visible:outline-none focus-visible:ring-0 focus-visible:border-[#FFD79A] transition-colors [background-image:none] appearance-none';
const labelClasses = 'text-[13px] text-foreground/80 font-medium';
const outlineButtonClasses = 'h-8 text-[13px] font-medium rounded-lg px-4 border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-sm text-foreground/80 hover:text-foreground transition-colors';
const primaryButtonClasses = 'h-8 text-[13px] font-medium rounded-lg px-4 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm shadow-[#FF922B]/25 transition-colors';
const infoCardClasses = 'space-y-1 rounded-lg bg-white dark:bg-muted border border-black/[0.06] dark:border-white/10 p-3.5';

function ChannelLogo({ type, muted = false }: { type: ChannelType; muted?: boolean }) {
  const iconClass = cn('w-[20px] h-[20px]', muted && 'opacity-45 dark:opacity-60', 'dark:invert');
  switch (type) {
    case 'telegram':
      return <img src={telegramIcon} alt="Telegram" className={iconClass} />;
    case 'discord':
      return <img src={discordIcon} alt="Discord" className={iconClass} />;
    case 'whatsapp':
      return <img src={whatsappIcon} alt="WhatsApp" className={iconClass} />;
    case 'wechat':
      return <img src={wechatIcon} alt="WeChat" className={iconClass} />;
    case 'dingtalk':
      return <img src={dingtalkIcon} alt="DingTalk" className={iconClass} />;
    case 'feishu':
      return <img src={feishuIcon} alt="Feishu" className={iconClass} />;
    case 'wecom':
      return <img src={wecomIcon} alt="WeCom" className={iconClass} />;
    case 'qqbot':
      return <img src={qqIcon} alt="QQ" className={iconClass} />;
    default:
      return <span className={cn('text-[20px] leading-none', muted && 'opacity-45 dark:opacity-60')}>{CHANNEL_ICONS[type] || '💬'}</span>;
  }
}

function AddAgentDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, options: { inheritWorkspace: boolean }) => Promise<void>;
}) {
  const { t } = useTranslation('agents');
  const [name, setName] = useState('');
  const [inheritWorkspace, setInheritWorkspace] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onCreate(name.trim(), { inheritWorkspace });
    } catch (error) {
      toast.error(t('toast.agentCreateFailed', { error: String(error) }));
      setSaving(false);
      return;
    }
    setSaving(false);
  };

  return (
    <ModalOverlay className="p-4">
      <Card className="w-full max-w-md rounded-2xl border-0 shadow-2xl bg-white dark:bg-card overflow-hidden">
        <CardHeader className="pb-2 px-6 pt-6">
          <CardTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
            {t('createDialog.title')}
          </CardTitle>
          <CardDescription className="text-[13px] mt-1 text-muted-foreground">
            {t('createDialog.description')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 pt-3 px-6 pb-6">
          <div className="space-y-2">
            <Label htmlFor="agent-name" className={labelClasses}>{t('createDialog.nameLabel')}</Label>
            <Input
              id="agent-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('createDialog.namePlaceholder')}
              className={inputClasses}
            />
          </div>
          <div className="flex items-center justify-between bg-white dark:bg-muted px-3.5 py-3 rounded-lg border border-black/[0.06] dark:border-white/10">
            <div className="space-y-0.5 pr-4">
              <Label htmlFor="inherit-workspace" className={labelClasses}>{t('createDialog.inheritWorkspaceLabel')}</Label>
              <p className="text-[12px] text-muted-foreground">{t('createDialog.inheritWorkspaceDescription')}</p>
            </div>
            <Switch
              id="inherit-workspace"
              size="sm"
              className="origin-right scale-[0.75]"
              checked={inheritWorkspace}
              onCheckedChange={setInheritWorkspace}
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={onClose}
              className="h-8 text-[13px] font-medium rounded-lg px-4 border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 shadow-sm text-foreground/80 hover:text-foreground transition-colors"
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSubmit()}
              disabled={saving || !name.trim()}
              className="h-8 text-[13px] font-medium rounded-lg px-4 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm shadow-[#FF922B]/25 transition-colors"
            >
              {saving ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  {t('creating')}
                </>
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
    </ModalOverlay>
  );
}

function AgentSettingsModal({
  agent,
  channelGroups,
  onClose,
}: {
  agent: AgentSummary;
  channelGroups: ChannelGroupItem[];
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const { updateAgent, defaultModelRef } = useAgentsStore();
  const [name, setName] = useState(agent.name);
  const [savingName, setSavingName] = useState(false);
  const [showModelModal, setShowModelModal] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);

  useEffect(() => {
    setName(agent.name);
  }, [agent.name]);

  const hasNameChanges = name.trim() !== agent.name;

  const handleRequestClose = () => {
    if (savingName || hasNameChanges) {
      setShowCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handleSaveName = async () => {
    if (!name.trim() || name.trim() === agent.name) return;
    setSavingName(true);
    try {
      await updateAgent(agent.id, name.trim());
      toast.success(t('toast.agentUpdated'));
    } catch (error) {
      toast.error(t('toast.agentUpdateFailed', { error: String(error) }));
    } finally {
      setSavingName(false);
    }
  };

  const assignedChannels = channelGroups.flatMap((group) =>
    group.accounts
      .filter((account) => account.agentId === agent.id)
      .map((account) => ({
        channelType: group.channelType as ChannelType,
        accountId: account.accountId,
        name:
          account.accountId === 'default'
            ? t('settingsDialog.mainAccount')
            : account.name || account.accountId,
        error: account.lastError,
      })),
  );

  return (
    <ModalOverlay className="p-4">
      <Card className="w-full max-w-2xl max-h-[90vh] flex flex-col rounded-2xl border-0 shadow-2xl bg-white dark:bg-card overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2 shrink-0 px-6 pt-6">
          <div>
            <CardTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
              {t('settingsDialog.title', { name: agent.name })}
            </CardTitle>
            <CardDescription className="text-[13px] mt-1 text-muted-foreground">
              {t('settingsDialog.description')}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRequestClose}
            className="rounded-lg h-8 w-8 -mr-1 -mt-1 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-5 pt-2 overflow-y-auto flex-1 px-6 pb-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="agent-settings-name" className={labelClasses}>{t('settingsDialog.nameLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  id="agent-settings-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  readOnly={agent.isDefault}
                  className={inputClasses}
                />
                {!agent.isDefault && (
                  <Button
                    onClick={() => void handleSaveName()}
                    disabled={savingName || !name.trim() || name.trim() === agent.name}
                    className={`${primaryButtonClasses} shrink-0`}
                  >
                    {savingName ? (
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      t('common:actions.save')
                    )}
                  </Button>
                )}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <div className={infoCardClasses}>
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-medium">
                  {t('settingsDialog.agentIdLabel')}
                </p>
                <p className="font-mono text-[13px] text-foreground">{agent.id}</p>
              </div>
              <button
                type="button"
                onClick={() => setShowModelModal(true)}
                className={`${infoCardClasses} text-left hover:border-[#FFD79A]/60 hover:bg-[#FFF2E5]/40 dark:hover:bg-[#FFF2E5]/5 transition-colors`}
              >
                <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground font-medium">
                  {t('settingsDialog.modelLabel')}
                </p>
                <p className="text-[13px] font-medium text-foreground">
                  {agent.modelDisplay}
                  {agent.inheritedModel ? ` (${t('inherited')})` : ''}
                </p>
                <p className="font-mono text-[12px] text-muted-foreground break-all">
                  {agent.modelRef || defaultModelRef || '-'}
                </p>
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <h3 className="text-[14px] font-sans font-semibold text-foreground">
                {t('settingsDialog.channelsTitle')}
              </h3>
              <p className="text-[12px] text-muted-foreground mt-0.5">{t('settingsDialog.channelsDescription')}</p>
            </div>

            {assignedChannels.length === 0 && agent.channelTypes.length === 0 ? (
              <div className="rounded-lg border border-dashed border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-4 text-[13px] text-muted-foreground">
                {t('settingsDialog.noChannels')}
              </div>
            ) : (
              <div className="space-y-2">
                {assignedChannels.map((channel) => (
                  <div key={`${channel.channelType}-${channel.accountId}`} className="flex items-center justify-between rounded-lg bg-white dark:bg-muted border border-black/[0.06] dark:border-white/10 p-3.5">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="h-9 w-9 shrink-0 flex items-center justify-center">
                        <ChannelLogo type={channel.channelType} muted />
                      </div>
                      <div className="min-w-0">
                        <p className="text-[13px] font-medium text-foreground">{channel.name}</p>
                        <p className="text-[12px] text-muted-foreground">
                          {CHANNEL_NAMES[channel.channelType]} · {channel.accountId === 'default' ? t('settingsDialog.mainAccount') : channel.accountId}
                        </p>
                        {channel.error && (
                          <p className="text-[11px] text-destructive mt-0.5">{channel.error}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
                {assignedChannels.length === 0 && agent.channelTypes.length > 0 && (
                  <div className="rounded-lg border border-dashed border-black/10 dark:border-white/10 bg-black/[0.02] dark:bg-white/[0.02] p-4 text-[13px] text-muted-foreground">
                    {t('settingsDialog.channelsManagedInChannels')}
                  </div>
                )}
              </div>
            )}
          </div>
        </CardContent>
      </Card>
      {showModelModal && (
        <AgentModelModal
          agent={agent}
          onClose={() => setShowModelModal(false)}
        />
      )}
      <ConfirmDialog
        open={showCloseConfirm}
        title={t('settingsDialog.unsavedChangesTitle')}
        message={t('settingsDialog.unsavedChangesMessage')}
        confirmLabel={t('settingsDialog.closeWithoutSaving')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          setShowCloseConfirm(false);
          setName(agent.name);
          onClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </ModalOverlay>
  );
}

function AgentModelModal({
  agent,
  onClose,
}: {
  agent: AgentSummary;
  onClose: () => void;
}) {
  const { t } = useTranslation('agents');
  const providerAccounts = useProviderStore((state) => state.accounts);
  const providerStatuses = useProviderStore((state) => state.statuses);
  const providerVendors = useProviderStore((state) => state.vendors);
  const providerDefaultAccountId = useProviderStore((state) => state.defaultAccountId);
  const { updateAgentModel, defaultModelRef } = useAgentsStore();
  const [selectedRuntimeProviderKey, setSelectedRuntimeProviderKey] = useState('');
  const [modelIdInput, setModelIdInput] = useState('');
  const [savingModel, setSavingModel] = useState(false);
  const [showCloseConfirm, setShowCloseConfirm] = useState(false);
  const initialFormRef = useRef({ providerKey: '', modelId: '' });

  const runtimeProviderOptions = useMemo<RuntimeProviderOption[]>(() => {
    const vendorMap = new Map<string, ProviderVendorInfo>(providerVendors.map((vendor) => [vendor.id, vendor]));
    const statusById = new Map<string, ProviderWithKeyInfo>(providerStatuses.map((status) => [status.id, status]));
    const entries = providerAccounts
      .filter((account) => account.enabled && hasConfiguredProviderCredentials(account, statusById))
      .sort((left, right) => {
        if (left.id === providerDefaultAccountId) return -1;
        if (right.id === providerDefaultAccountId) return 1;
        return right.updatedAt.localeCompare(left.updatedAt);
      });

    const deduped = new Map<string, RuntimeProviderOption>();
    for (const account of entries) {
      const runtimeProviderKey = resolveRuntimeProviderKey(account);
      if (!runtimeProviderKey || deduped.has(runtimeProviderKey)) continue;
      const vendor = vendorMap.get(account.vendorId);
      const label = `${account.label} (${vendor?.name || account.vendorId})`;
      const configuredModelId = account.model
        ? (account.model.startsWith(`${runtimeProviderKey}/`)
          ? account.model.slice(runtimeProviderKey.length + 1)
          : account.model)
        : undefined;

      deduped.set(runtimeProviderKey, {
        runtimeProviderKey,
        accountId: account.id,
        label,
        modelIdPlaceholder: vendor?.modelIdPlaceholder,
        configuredModelId,
      });
    }

    return [...deduped.values()];
  }, [providerAccounts, providerDefaultAccountId, providerStatuses, providerVendors]);

  useEffect(() => {
    const override = splitModelRef(agent.overrideModelRef);
    let providerKey = '';
    let modelId = '';

    if (override) {
      providerKey = override.providerKey;
      modelId = override.modelId;
    } else {
      const effective = splitModelRef(agent.modelRef || defaultModelRef);
      if (effective) {
        providerKey = effective.providerKey;
        modelId = effective.modelId;
      } else {
        providerKey = runtimeProviderOptions[0]?.runtimeProviderKey || '';
        modelId = runtimeProviderOptions[0]?.configuredModelId || '';
      }
    }

    initialFormRef.current = { providerKey, modelId };
    setSelectedRuntimeProviderKey(providerKey);
    setModelIdInput(modelId);
  }, [agent.modelRef, agent.overrideModelRef, defaultModelRef, runtimeProviderOptions]);

  const selectedProvider = runtimeProviderOptions.find((option) => option.runtimeProviderKey === selectedRuntimeProviderKey) || null;
  const trimmedModelId = modelIdInput.trim();
  const nextModelRef = selectedRuntimeProviderKey && trimmedModelId
    ? `${selectedRuntimeProviderKey}/${trimmedModelId}`
    : '';
  const normalizedDefaultModelRef = (defaultModelRef || '').trim();
  const isUsingDefaultModelInForm = Boolean(normalizedDefaultModelRef) && nextModelRef === normalizedDefaultModelRef;
  const desiredOverrideModelRef = nextModelRef && nextModelRef !== normalizedDefaultModelRef
    ? nextModelRef
    : null;
  const modelChanged =
    selectedRuntimeProviderKey !== initialFormRef.current.providerKey
    || trimmedModelId !== initialFormRef.current.modelId;

  const handleRequestClose = () => {
    if (savingModel || modelChanged) {
      setShowCloseConfirm(true);
      return;
    }
    onClose();
  };

  const handleSaveModel = async () => {
    if (!selectedRuntimeProviderKey) {
      toast.error(t('toast.agentModelProviderRequired'));
      return;
    }
    if (!trimmedModelId) {
      toast.error(t('toast.agentModelIdRequired'));
      return;
    }
    if (!modelChanged) return;
    if (!nextModelRef.includes('/')) {
      toast.error(t('toast.agentModelInvalid'));
      return;
    }

    setSavingModel(true);
    try {
      await updateAgentModel(agent.id, desiredOverrideModelRef);
      toast.success(desiredOverrideModelRef ? t('toast.agentModelUpdated') : t('toast.agentModelReset'));
      onClose();
    } catch (error) {
      toast.error(t('toast.agentModelUpdateFailed', { error: String(error) }));
    } finally {
      setSavingModel(false);
    }
  };

  const handleUseDefaultModel = () => {
    const parsedDefault = splitModelRef(normalizedDefaultModelRef);
    if (!parsedDefault) {
      setSelectedRuntimeProviderKey('');
      setModelIdInput('');
      return;
    }
    setSelectedRuntimeProviderKey(parsedDefault.providerKey);
    setModelIdInput(parsedDefault.modelId);
  };

  return (
    <ModalOverlay className="p-4" zIndexClass="z-[60]">
      <Card className="w-full max-w-xl rounded-2xl border-0 shadow-2xl bg-white dark:bg-card overflow-hidden">
        <CardHeader className="flex flex-row items-start justify-between pb-2 px-6 pt-6">
          <div>
            <CardTitle className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal">
              {t('settingsDialog.modelLabel')}
            </CardTitle>
            <CardDescription className="text-[13px] mt-1 text-muted-foreground">
              {t('settingsDialog.modelOverrideDescription', { defaultModel: defaultModelRef || '-' })}
            </CardDescription>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleRequestClose}
            className="rounded-lg h-8 w-8 -mr-1 -mt-1 text-muted-foreground hover:text-foreground hover:bg-black/5 dark:hover:bg-white/5"
          >
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4 px-6 pb-6 pt-2">
          <div className="space-y-2">
            <Label htmlFor="agent-model-provider" className={labelClasses}>{t('settingsDialog.modelProviderLabel')}</Label>
            <select
              id="agent-model-provider"
              value={selectedRuntimeProviderKey}
              onChange={(event) => {
                const nextProvider = event.target.value;
                setSelectedRuntimeProviderKey(nextProvider);
                const option = runtimeProviderOptions.find((candidate) => candidate.runtimeProviderKey === nextProvider);
                setModelIdInput(option?.configuredModelId || '');
              }}
              className={selectClasses}
            >
              <option value="">{t('settingsDialog.modelProviderPlaceholder')}</option>
              {runtimeProviderOptions.map((option) => (
                <option key={option.runtimeProviderKey} value={option.runtimeProviderKey}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="agent-model-id" className={labelClasses}>{t('settingsDialog.modelIdLabel')}</Label>
            <Input
              id="agent-model-id"
              value={modelIdInput}
              onChange={(event) => setModelIdInput(event.target.value)}
              placeholder={selectedProvider?.modelIdPlaceholder || selectedProvider?.configuredModelId || t('settingsDialog.modelIdPlaceholder')}
              className={inputClasses}
            />
          </div>
          {!!nextModelRef && (
            <p className="text-[12px] font-mono text-muted-foreground break-all">
              {t('settingsDialog.modelPreview')}: {nextModelRef}
            </p>
          )}
          {runtimeProviderOptions.length === 0 && (
            <p className="text-[12px] rounded-lg bg-[#FFF2E5] px-3 py-2 text-[#FF6A00] border border-[#FFD79A]/60">
              {t('settingsDialog.modelProviderEmpty')}
            </p>
          )}
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button
              variant="outline"
              onClick={handleUseDefaultModel}
              disabled={savingModel || !normalizedDefaultModelRef || isUsingDefaultModelInForm}
              className={outlineButtonClasses}
            >
              {t('settingsDialog.useDefaultModel')}
            </Button>
            <Button
              variant="outline"
              onClick={handleRequestClose}
              className={outlineButtonClasses}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              onClick={() => void handleSaveModel()}
              disabled={savingModel || !selectedRuntimeProviderKey || !trimmedModelId || !modelChanged}
              className={primaryButtonClasses}
            >
              {savingModel ? (
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t('common:actions.save')
              )}
            </Button>
          </div>
        </CardContent>
      </Card>
      <ConfirmDialog
        open={showCloseConfirm}
        zIndexClass="z-[70]"
        title={t('settingsDialog.unsavedChangesTitle')}
        message={t('settingsDialog.unsavedChangesMessage')}
        confirmLabel={t('settingsDialog.closeWithoutSaving')}
        cancelLabel={t('common:actions.cancel')}
        onConfirm={() => {
          setShowCloseConfirm(false);
          onClose();
        }}
        onCancel={() => setShowCloseConfirm(false)}
      />
    </ModalOverlay>
  );
}

export default Agents;
