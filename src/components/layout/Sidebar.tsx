/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Network,
  Bot,
  Puzzle,
  Link2,
  Clock,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  Terminal,
  ExternalLink,
  Trash2,
  Cpu,
  Folder,
  FolderOpen,
  ChevronRight,
  Loader2,
  X,
  LogOut,
  User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useWorkspacesStore } from '@/stores/workspaces';
import { useDingTalkAuthStore } from '@/stores/dingtalk-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { hostApiFetch } from '@/lib/host-api';
import { toUserMessage } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { isFirstResponsePreparing } from '@/lib/chat-first-response-preparing';
import logoSvg from '@/assets/1.png';

/** While Chat shows first-response preparing, block switching sessions (sidebar + workspace). */
function blockSessionSwitchIfFirstResponsePreparing(): boolean {
  const chat = useChatStore.getState();
  const gw = useGatewayStore.getState().status;
  if (
    !isFirstResponsePreparing({
      gatewayStatus: gw,
      sending: chat.sending,
      streamingMessage: chat.streamingMessage,
      streamingText: chat.streamingText,
      streamingTools: chat.streamingTools,
    })
  ) {
    return false;
  }
  toast.info(i18n.t('chat:sidebar.sessionSwitchBlockedWhilePreparing'));
  return true;
}

type SessionBucketKey =
  | 'today'
  | 'yesterday'
  | 'withinWeek'
  | 'withinTwoWeeks'
  | 'withinMonth'
  | 'older';

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  onClick?: () => void;
  testId?: string;
}

function NavItem({ to, icon, label, badge, collapsed, onClick, testId }: NavItemProps) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          'group flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-all',
          !isActive &&
            'hover:bg-black/10 hover:shadow-md hover:shadow-black/[0.12] dark:hover:bg-white/10 dark:hover:shadow-md dark:hover:shadow-white/[0.12]',
          isActive
            ? 'bg-[#FF7B00] text-white shadow-md shadow-[#FF7B00]/30 dark:bg-white/10 dark:text-foreground dark:shadow-none'
            : 'text-foreground/80',
          collapsed && 'justify-center px-0'
        )
      }
    >
      {({ isActive }) => (
        <>
          <div
            className={cn(
              'flex shrink-0 items-center justify-center transition-colors',
              isActive ? 'text-white dark:text-foreground' : 'text-muted-foreground',
            )}
          >
            {icon}
          </div>
          {!collapsed && (
            <>
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
              {badge && (
                <Badge variant="secondary" className="ml-auto shrink-0">
                  {badge}
                </Badge>
              )}
            </>
          )}
        </>
      )}
    </NavLink>
  );
}

function getSessionBucket(activityMs: number, nowMs: number): SessionBucketKey {
  if (!activityMs || activityMs <= 0) return 'older';

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;

  if (activityMs >= startOfToday) return 'today';
  if (activityMs >= startOfYesterday) return 'yesterday';

  const daysAgo = (startOfToday - activityMs) / (24 * 60 * 60 * 1000);
  if (daysAgo <= 7) return 'withinWeek';
  if (daysAgo <= 14) return 'withinTwoWeeks';
  if (daysAgo <= 30) return 'withinMonth';
  return 'older';
}

const INITIAL_NOW_MS = Date.now();

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

const STARTUP_LOAD_SESSIONS_DELAY_MS = 0;
const STARTING_FALLBACK_LOAD_SESSIONS_DELAY_MS = 5_000;

export function Sidebar() {
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);
  const devModeUnlocked = useSettingsStore((state) => state.devModeUnlocked);

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const sessionWorkspaceIds = useChatStore((s) => s.sessionWorkspaceIds);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const chatSending = useChatStore((s) => s.sending);
  const activeRunId = useChatStore((s) => s.activeRunId);
  const messages = useChatStore((s) => s.messages);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const streamingText = useChatStore((s) => s.streamingText);
  const streamingTools = useChatStore((s) => s.streamingTools);

  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const isGatewayReady = isGatewayRunning && gatewayStatus.gatewayReady === true;
  const isChatActive = chatSending || !!activeRunId;

  const firstResponsePreparingLocksSwitch = useMemo(
    () => isFirstResponsePreparing({
      gatewayStatus,
      sending: chatSending,
      streamingMessage,
      streamingText,
      streamingTools,
    }),
    [
      gatewayStatus.state,
      gatewayStatus.warmupStatus,
      chatSending,
      streamingMessage,
      streamingText,
      streamingTools,
    ],
  );

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const temporaryWorkspaces = useWorkspacesStore((s) => s.temporaryWorkspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const setCurrentWorkspace = useWorkspacesStore((s) => s.setCurrentWorkspace);
  const removeTemporaryWorkspace = useWorkspacesStore((s) => s.removeTemporaryWorkspace);
  const dingtalkUser = useDingTalkAuthStore((s) => s.user);
  const dingtalkLoading = useDingTalkAuthStore((s) => s.loading);
  const logoutDingTalk = useDingTalkAuthStore((s) => s.logout);

  // Only user-created workspaces are shown; agent/default folders are not
  // mounted automatically to avoid background reads of large directories.
  const allWorkspaces = [...temporaryWorkspaces, ...workspaces];

  const workspaceIdsKnown = useMemo(
    () => new Set(allWorkspaces.map((workspace) => workspace.id)),
    [allWorkspaces],
  );

  const sessionsByWorkspaceId = useMemo(() => {
    const map: Record<string, ChatSession[]> = Object.fromEntries(
      allWorkspaces.map((workspace) => [workspace.id, [] as ChatSession[]]),
    );
    for (const session of sessions) {
      const wid = sessionWorkspaceIds[session.key];
      if (wid && workspaceIdsKnown.has(wid)) {
        const list = map[wid];
        if (list) list.push(session);
      }
    }
    for (const workspace of allWorkspaces) {
      const list = map[workspace.id];
      if (list) {
        list.sort(
          (a, b) => (sessionLastActivity[b.key] ?? 0) - (sessionLastActivity[a.key] ?? 0),
        );
      }
    }
    return map;
  }, [allWorkspaces, sessions, sessionWorkspaceIds, workspaceIdsKnown, sessionLastActivity]);

  const isSessionListedUnderWorkspace = (sessionKey: string) => {
    const wid = sessionWorkspaceIds[sessionKey];
    return Boolean(wid && workspaceIdsKnown.has(wid));
  };

  // 工作空间区域折叠状态
  const [workspacesCollapsed, setWorkspacesCollapsed] = useState(false);
  /** Workspace ids whose per-workspace chat list is collapsed (default: expanded). */
  const [workspaceChatsCollapsedIds, setWorkspaceChatsCollapsedIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);

  const toggleWorkspaceSection = () => {
    setWorkspacesCollapsed(!workspacesCollapsed);
  };

  const toggleWorkspaceChatsCollapsed = (workspaceId: string) => {
    setWorkspaceChatsCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };

  const selectWorkspace = (workspaceId: string) => {
    setCurrentWorkspace(workspaceId);
    useChatStore.getState().bindCurrentSessionWorkspace(workspaceId);

    // 切换到对应 Agent 的主会话
    const agentsStore = useAgentsStore.getState();
    const agent = agentsStore.agents.find(a => a.id === workspaceId);
    if (agent) {
      const targetSessionKey = agent.mainSessionKey || `agent:${agent.id}:main`;
      
      if (currentSessionKey !== targetSessionKey) {
        if (blockSessionSwitchIfFirstResponsePreparing()) return;
        switchSession(targetSessionKey);
      }

      navigate('/');
    }
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    
    console.log(`[Sidebar] useEffect triggered: state=${gatewayStatus.state}, gatewayReady=${gatewayStatus.gatewayReady}, isGatewayReady=${isGatewayReady}, isChatActive=${isChatActive}`);
    
    if (isGatewayReady) {
      if (isChatActive) {
        console.log('[Sidebar] Chat active, deferring session list load');
        return () => {
          cancelled = true;
          if (timer) {
            clearTimeout(timer);
          }
        };
      }

      console.log(`[Sidebar] Gateway ready, scheduling session list load...`);

      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          const startTime = Date.now();
          console.log(`[Sidebar] Starting loadSessions() at ${startTime}`);
          await loadSessions();
          console.log(`[Sidebar] loadSessions() completed in ${Date.now() - startTime}ms`);
        })();
      }, STARTUP_LOAD_SESSIONS_DELAY_MS);
    } else if (gatewayStatus.state === 'starting') {
      console.log(`[Sidebar] Gateway starting, scheduling local fallback session list load...`);
      
      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          const startTime = Date.now();
          console.log(`[Sidebar] Starting loadSessions() (local fallback) at ${startTime}`);
          await loadSessions();
          console.log(`[Sidebar] loadSessions() (local fallback) completed in ${Date.now() - startTime}ms`);
        })();
      }, STARTING_FALLBACK_LOAD_SESSIONS_DELAY_MS);
    } else {
      console.log(`[Sidebar] Gateway not running (state=${gatewayStatus.state}), skipping load`);
    }
    
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [isGatewayReady, isChatActive, gatewayStatus.state, gatewayStatus.gatewayReady, loadSessions]);
  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const navigate = useNavigate();
  const isOnChat = useLocation().pathname === '/';

  const getSessionLabel = (key: string, displayName?: string, label?: string) =>
    sessionLabels[key] ?? label ?? displayName ?? key;

  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const { t } = useTranslation(['common', 'chat', 'settings']);
  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(null);
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (!userMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!userMenuRef.current?.contains(event.target as Node)) {
        setUserMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [userMenuOpen]);

  const dingtalkOrg = dingtalkUser
    ? dingtalkUser.exclusiveAccountCorpName
      || dingtalkUser.orgEmail
      || dingtalkUser.workPlace
      || ''
    : '';

  const handleUserSettings = () => {
    setUserMenuOpen(false);
    navigate('/settings');
  };

  const handleDingTalkLogout = async () => {
    try {
      await logoutDingTalk();
      setUserMenuOpen(false);
      toast.success(t('settings:dingtalk.logoutSuccess'));
    } catch (error) {
      toast.error(`${t('settings:dingtalk.logoutFailed')}: ${toUserMessage(error)}`);
    }
  };

  const agentNameById = useMemo(
    () => Object.fromEntries((agents ?? []).map((agent) => [agent.id, agent.name])),
    [agents],
  );

  const renderChatSessionRow = (s: ChatSession) => {
    const agentId = getAgentIdFromSessionKey(s.key);
    const agentName = agentNameById[agentId] || agentId;
    return (
      <div key={s.key} className="group relative flex items-center">
        <button
          type="button"
          data-testid={`sidebar-session-${s.key}`}
          onClick={() => {
            if (s.key === currentSessionKey) {
              navigate('/');
              return;
            }
            if (blockSessionSwitchIfFirstResponsePreparing()) return;
            switchSession(s.key);
            navigate('/');
          }}
          disabled={firstResponsePreparingLocksSwitch && s.key !== currentSessionKey}
          title={
            firstResponsePreparingLocksSwitch && s.key !== currentSessionKey
              ? i18n.t('chat:sidebar.sessionSwitchBlockedWhilePreparing')
              : undefined
          }
          className={cn(
            'w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] transition-colors pr-7',
            'hover:bg-black/10 dark:hover:bg-white/10',
            isOnChat && currentSessionKey === s.key
              ? 'bg-black/10 dark:bg-white/10 text-[#FF7B00] font-medium dark:text-foreground'
              : 'text-foreground/75',
            firstResponsePreparingLocksSwitch && s.key !== currentSessionKey && 'opacity-50 cursor-not-allowed',
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded-full bg-black/[0.14] px-2 py-0.5 text-[10px] font-medium text-foreground/70 dark:bg-white/[0.12]">
              {agentName}
            </span>
            <span className="truncate">{getSessionLabel(s.key, s.displayName, s.label)}</span>
          </div>
        </button>
        <button
          aria-label="Delete session"
          onClick={(e) => {
            e.stopPropagation();
            setSessionToDelete({
              key: s.key,
              label: getSessionLabel(s.key, s.displayName, s.label),
            });
          }}
          className={cn(
            'absolute right-1 flex items-center justify-center rounded p-0.5 transition-opacity',
            'opacity-0 group-hover:opacity-100',
            'text-muted-foreground hover:text-destructive hover:bg-destructive/10',
          )}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  };

  const sessionBuckets: Array<{ key: SessionBucketKey; label: string; sessions: typeof sessions }> = [
    { key: 'today', label: t('chat:historyBuckets.today'), sessions: [] },
    { key: 'yesterday', label: t('chat:historyBuckets.yesterday'), sessions: [] },
    { key: 'withinWeek', label: t('chat:historyBuckets.withinWeek'), sessions: [] },
    { key: 'withinTwoWeeks', label: t('chat:historyBuckets.withinTwoWeeks'), sessions: [] },
    { key: 'withinMonth', label: t('chat:historyBuckets.withinMonth'), sessions: [] },
    { key: 'older', label: t('chat:historyBuckets.older'), sessions: [] },
  ];
  const sessionBucketMap = Object.fromEntries(sessionBuckets.map((bucket) => [bucket.key, bucket])) as Record<
    SessionBucketKey,
    (typeof sessionBuckets)[number]
  >;

  for (const session of [...sessions].sort((a, b) =>
    (sessionLastActivity[b.key] ?? 0) - (sessionLastActivity[a.key] ?? 0)
  )) {
    if (isSessionListedUnderWorkspace(session.key)) continue;
    const bucketKey = getSessionBucket(sessionLastActivity[session.key] ?? 0, nowMs);
    sessionBucketMap[bucketKey].sessions.push(session);
  }

  const hiddenRoutes = rendererExtensionRegistry.getHiddenRoutes();
  const extraNavItems = rendererExtensionRegistry.getExtraNavItems();

  const coreNavItems = [
    { to: '/models', icon: <Cpu className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.models'), testId: 'sidebar-nav-models' },
    { to: '/agents', icon: <Bot className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.agents'), testId: 'sidebar-nav-agents' },
    { to: '/channels', icon: <Network className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.channels'), testId: 'sidebar-nav-channels' },
    { to: '/skills', icon: <Puzzle className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.skills'), testId: 'sidebar-nav-skills' },
    { to: '/connectors', icon: <Link2 className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.connectors'), testId: 'sidebar-nav-connectors' },
    { to: '/cron', icon: <Clock className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.cronTasks'), testId: 'sidebar-nav-cron' },
  ];

  const navItems = [
    ...coreNavItems.filter((item) => !hiddenRoutes.has(item.to)),
    ...extraNavItems.map((item) => ({
      to: item.to,
      icon: <item.icon className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: item.labelI18nKey ? t(item.labelI18nKey) : item.label,
      testId: item.testId,
    })),
  ];

  return (
    <aside
      data-testid="sidebar"
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden border-r bg-[#f8f8f6]/50 dark:bg-background transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Top Header Toggle */}
      <div className={cn("flex items-center p-2 h-12", sidebarCollapsed ? "justify-center" : "justify-between")}>
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2 px-2 overflow-hidden">
            <img src={logoSvg} alt="LYClaw" className="h-5 w-auto shrink-0" />
            <span className="text-sm font-semibold truncate whitespace-nowrap text-foreground/90">
              LYClaw
            </span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:bg-black/10 dark:hover:bg-white/10"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
        >
          {sidebarCollapsed ? (
            <PanelLeft className="h-[18px] w-[18px]" />
          ) : (
            <PanelLeftClose className="h-[18px] w-[18px]" />
          )}
        </Button>
      </div>

      {/* Navigation */}
      <nav className="flex flex-col px-2 gap-0.5">
        <button
          data-testid="sidebar-new-chat"
          type="button"
          onClick={() => {
            const { messages: ms } = useChatStore.getState();
            if (ms.length > 0) {
              if (blockSessionSwitchIfFirstResponsePreparing()) return;
              newSession();
            }
            navigate('/');
          }}
          disabled={firstResponsePreparingLocksSwitch && messages.length > 0}
          title={
            firstResponsePreparingLocksSwitch && messages.length > 0
              ? i18n.t('chat:sidebar.sessionSwitchBlockedWhilePreparing')
              : undefined
          }
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors mb-2',
            'bg-black/10 dark:bg-accent shadow-none border border-transparent text-foreground',
            sidebarCollapsed && 'justify-center px-0',
            firstResponsePreparingLocksSwitch && messages.length > 0 && 'opacity-50 cursor-not-allowed',
          )}
        >
          <div className="flex shrink-0 items-center justify-center text-foreground/80">
            <Plus className="h-[18px] w-[18px]" strokeWidth={2} />
          </div>
          {!sidebarCollapsed && <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.newChat')}</span>}
        </button>

        {navItems.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            collapsed={sidebarCollapsed}
          />
        ))}
      </nav>

      {/* Workspace section */}
      {!sidebarCollapsed && allWorkspaces.length > 0 && (
        <div data-testid="sidebar-workspaces-section" className="px-2 pt-4 pb-2">
          <div
            className="flex items-center justify-between px-2.5 pb-1 cursor-pointer hover:bg-black/10 dark:hover:bg-white/10 rounded-lg"
            onClick={toggleWorkspaceSection}
          >
            <span className="text-[14px] font-medium text-foreground tracking-tight">
              {t('sidebar.workspaces')}
            </span>
            <ChevronRight
              className={cn(
                'h-3 w-3 text-muted-foreground transition-transform',
                !workspacesCollapsed && 'rotate-90',
              )}
            />
          </div>
          {!workspacesCollapsed && (
            <div className="space-y-0.5 mt-1">
              {allWorkspaces
                .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
                .map((workspace) => {
                  const displayName = workspace.name;
                  const isSelected = currentWorkspaceId === workspace.id;
                  const sessionCount = sessionsByWorkspaceId[workspace.id]?.length ?? 0;
                  const chatsExpanded =
                    sessionCount > 0 && !workspaceChatsCollapsedIds.has(workspace.id);

                  const handleWorkspaceBodyClick = () => {
                    const wid = workspace.id;
                    const alreadySelected = currentWorkspaceId === wid;
                    selectWorkspace(wid);
                    if (sessionCount === 0) return;
                    if (alreadySelected) {
                      toggleWorkspaceChatsCollapsed(wid);
                    } else {
                      setWorkspaceChatsCollapsedIds((prev) => {
                        const next = new Set(prev);
                        next.delete(wid);
                        return next;
                      });
                    }
                  };

                  return (
                    <div key={workspace.id}>
                      <div
                        data-testid={`sidebar-workspace-row-${workspace.id}`}
                        className={cn(
                          'w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] transition-colors flex items-center gap-2 cursor-pointer group',
                          'hover:bg-black/10 dark:hover:bg-white/10',
                          'w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] transition-colors flex items-center gap-1 group',
                          'hover:bg-black/5 dark:hover:bg-white/5',
                          isSelected
                            ? 'bg-black/10 dark:bg-white/10 text-foreground font-medium'
                            : 'text-foreground/75',
                        )}
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          data-testid={
                            sessionCount > 0
                              ? `sidebar-workspace-chats-toggle-${workspace.id}`
                              : undefined
                          }
                          aria-expanded={sessionCount > 0 ? chatsExpanded : undefined}
                          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                          onClick={handleWorkspaceBodyClick}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              handleWorkspaceBodyClick();
                            }
                          }}
                          title={workspace.path}
                        >
                          {sessionCount > 0 ? (
                            <ChevronRight
                              className={cn(
                                'h-3 w-3 shrink-0 text-muted-foreground transition-transform pointer-events-none',
                                chatsExpanded && 'rotate-90',
                              )}
                              aria-hidden
                            />
                          ) : (
                            <span className="inline-flex h-3 w-3 shrink-0" aria-hidden />
                          )}
                          {isSelected ? (
                            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                          ) : (
                            <Folder className="h-3.5 w-3.5 shrink-0" />
                          )}
                          <span className="truncate">{displayName}</span>
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            type="button"
                            className="flex shrink-0 items-center justify-center w-5 h-5 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                            onClick={(e) => {
                              e.stopPropagation();
                              window.electron.ipcRenderer.invoke('shell:openPath', workspace.path);
                            }}
                            title="打开文件夹"
                          >
                            <ExternalLink className="h-3 w-3 text-muted-foreground" />
                          </button>
                          <button
                            type="button"
                            className="flex shrink-0 items-center justify-center w-5 h-5 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeTemporaryWorkspace(workspace.id);
                            }}
                            title="移除工作空间"
                          >
                            <X className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </div>
                      </div>

                      {sessionCount > 0 ? (
                        <div
                          data-testid={`sidebar-workspace-sessions-${workspace.id}`}
                          className="ml-6 mt-1"
                        >
                          {chatsExpanded ? (
                            <div className="max-h-40 space-y-0.5 overflow-y-auto overflow-x-hidden scrollbar-thin">
                              {sessionsByWorkspaceId[workspace.id]!.map(renderChatSessionRow)}
                            </div>
                          ) : null}
                        </div>
                      ) : null}

                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}

      {/* Session list — below Settings, only when expanded */}
      {!sidebarCollapsed && sessions.some((s) => !isSessionListedUnderWorkspace(s.key)) && (
        <div className="mt-4 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-0.5">
          {sessionBuckets.map((bucket) => (
            bucket.sessions.length > 0 ? (
              <div key={bucket.key} className="pt-2">
                <div className="px-2.5 pb-1 text-[11px] font-medium text-muted-foreground/60 tracking-tight">
                  {bucket.label}
                </div>
                {bucket.sessions.map(renderChatSessionRow)}
              </div>
            ) : null
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="relative p-2 mt-auto" ref={userMenuRef}>
        {dingtalkUser ? (
          <>
            {userMenuOpen && (
              <div
                data-testid="sidebar-user-menu"
                className={cn(
                  'absolute bottom-full z-50 mb-2 rounded-2xl border border-black/10 bg-[#f7f4ec] p-2 shadow-xl dark:border-white/10 dark:bg-card',
                  sidebarCollapsed ? 'left-2 w-56' : 'left-2 right-2',
                )}
              >
                <button
                  data-testid="sidebar-nav-settings"
                  type="button"
                  onClick={handleUserSettings}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium text-foreground/85 transition-colors hover:bg-black/10 dark:hover:bg-white/10',
                    sidebarCollapsed ? 'justify-center px-0 w-10 h-10' : 'text-left w-full'
                  )}
                >
                  <div className="flex shrink-0 items-center justify-center text-muted-foreground">
                    <SettingsIcon className="h-[18px] w-[18px]" strokeWidth={2} />
                  </div>
                  {!sidebarCollapsed && <span>{t('common:sidebar.settings')}</span>}
                </button>
                <button
                  type="button"
                  onClick={handleDingTalkLogout}
                  disabled={dingtalkLoading}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium text-[#FF7B00] transition-colors hover:bg-[#FF7B00]/10 disabled:opacity-60',
                    sidebarCollapsed ? 'justify-center px-0 w-10 h-10' : 'text-left w-full'
                  )}
                >
                  <div className="flex shrink-0 items-center justify-center text-[#FF7B00]">
                    {dingtalkLoading ? (
                      <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={2} />
                    ) : (
                      <LogOut className="h-[18px] w-[18px]" strokeWidth={2} />
                    )}
                  </div>
                  {!sidebarCollapsed && <span>{t('settings:dingtalk.logout')}</span>}
                </button>
              </div>
            )}

            <button
              type="button"
              data-testid="sidebar-user-profile"
              onClick={() => setUserMenuOpen((open) => !open)}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors hover:bg-black/10 dark:hover:bg-white/10',
                sidebarCollapsed ? 'justify-center' : '',
              )}
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-black/10 text-[12px] font-semibold text-foreground dark:bg-white/10">
                {dingtalkUser.avatar ? (
                  <img src={dingtalkUser.avatar} alt={dingtalkUser.name} className="h-full w-full object-cover" />
                ) : (
                  <User className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              {!sidebarCollapsed && (
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium text-foreground">
                    {dingtalkUser.name || dingtalkUser.nickname || t('settings:dingtalk.account')}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {dingtalkOrg || t('settings:dingtalk.account')}
                  </div>
                </div>
              )}
            </button>
          </>
        ) : (
          <NavLink
            to="/settings"
            data-testid="sidebar-nav-settings"
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-colors',
                'hover:bg-black/10 dark:hover:bg-white/10 text-foreground/80',
                isActive && 'bg-black/10 dark:bg-white/10 text-foreground',
                sidebarCollapsed ? 'justify-center px-0 w-full' : ''
              )
            }
          >
          {({ isActive }) => (
            <>
              <div className={cn("flex shrink-0 items-center justify-center", isActive ? "text-foreground" : "text-muted-foreground")}>
                <SettingsIcon className="h-[18px] w-[18px]" strokeWidth={2} />
              </div>
              {!sidebarCollapsed && <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t('sidebar.settings')}</span>}
            </>
          )}
          </NavLink>
        )}

        {devModeUnlocked && (
          <Button
            data-testid="sidebar-open-dev-console"
            variant="ghost"
            className={cn(
              'flex items-center gap-2.5 rounded-lg px-2.5 py-2 h-auto text-[14px] font-medium transition-colors w-full mt-1',
              'hover:bg-black/10 dark:hover:bg-white/10 text-foreground/80',
              sidebarCollapsed ? 'justify-center px-0' : 'justify-start'
            )}
            onClick={openDevConsole}
          >
            <div className="flex shrink-0 items-center justify-center text-muted-foreground">
              <Terminal className="h-[18px] w-[18px]" strokeWidth={2} />
            </div>
            {!sidebarCollapsed && (
              <>
                <span className="flex-1 text-left overflow-hidden text-ellipsis whitespace-nowrap">{t('common:sidebar.openClawPage')}</span>
                <ExternalLink className="h-3 w-3 shrink-0 ml-auto opacity-50 text-muted-foreground" />
              </>
            )}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={!!sessionToDelete}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteSessionConfirm', { label: sessionToDelete?.label })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        onConfirm={async () => {
          if (!sessionToDelete) return;
          await deleteSession(sessionToDelete.key);
          if (currentSessionKey === sessionToDelete.key) navigate('/');
          setSessionToDelete(null);
        }}
        onCancel={() => setSessionToDelete(null)}
      />
    </aside>
  );
}
