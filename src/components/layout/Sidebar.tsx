/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { version } from '@/../package.json';
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
  Pencil,
  FolderOutput,
  Cpu,
  Folder,
  FolderOpen,
  ChevronRight,
  Loader2,
  X,
  LogOut,
  User,
  CheckCircle2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore, type ChatSession } from '@/stores/chat';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useWorkspacesStore } from '@/stores/workspaces';
import { useDingTalkAuthStore } from '@/stores/dingtalk-auth';
import { useUpdateStore, shouldShowUpdateAvailableBadge } from '@/stores/update';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { hostApiFetch } from '@/lib/host-api';
import { flushUiStateSync } from '@/lib/ui-state-persistence';
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
            'hover:bg-white/60 hover:shadow-sm dark:hover:bg-white/10 dark:hover:shadow-md dark:hover:shadow-white/[0.12]',
          isActive
            ? 'bg-white text-[#FF922B] shadow-sm shadow-black/[0.04] dark:bg-white/10 dark:text-foreground dark:shadow-none'
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
              isActive ? 'text-[#FF922B] dark:text-foreground' : 'text-muted-foreground',
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
  const customSessionLabels = useChatStore((s) => s.customSessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const sessionWorkspaceIds = useChatStore((s) => s.sessionWorkspaceIds);
  const sessionStreamingStates = useChatStore((s) => s.sessionStreamingStates);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const clearSessionWorkspaceBindings = useChatStore((s) => s.clearSessionWorkspaceBindings);
  const unbindSessionWorkspace = useChatStore((s) => s.unbindSessionWorkspace);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
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
  const updateStatus = useUpdateStore((s) => s.status);
  const checkForUpdatesAfterGatewayReady = useUpdateStore((s) => s.checkForUpdatesAfterGatewayReady);
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

  /**
   * The session entry for a freshly-clicked "+ 新对话" that hasn't sent any
   * messages yet is hidden from the sidebar lists. It only shows up once the
   * user actually sends a message (which assigns activity / messages).
   */
  const isPendingNewSession = (sessionKey: string): boolean => {
    if (sessionKey !== currentSessionKey) return false;
    if (messages.length > 0) return false;
    if (sessionLastActivity[sessionKey]) return false;
    if (sessionLabels[sessionKey]) return false;
    return true;
  };

  const sessionsByWorkspaceId = useMemo(() => {
    const map: Record<string, ChatSession[]> = Object.fromEntries(
      allWorkspaces.map((workspace) => [workspace.id, [] as ChatSession[]]),
    );
    for (const session of sessions) {
      if (isPendingNewSession(session.key)) continue;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isPendingNewSession depends on currentSessionKey/messages/sessionLastActivity which are all listed below
  }, [allWorkspaces, sessions, sessionWorkspaceIds, workspaceIdsKnown, sessionLastActivity, sessionLabels, currentSessionKey, messages.length]);

  const activeWorkspaceId = sessionWorkspaceIds[currentSessionKey] ?? null;

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

  useEffect(() => {
    if (!isGatewayReady) return;
    void checkForUpdatesAfterGatewayReady();
  }, [isGatewayReady, checkForUpdatesAfterGatewayReady]);

  const agents = useAgentsStore((s) => s.agents);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const navigate = useNavigate();
  const isOnChat = useLocation().pathname === '/';

  // Distinguish "+ 新对话" active state from "session selected" active state.
  // A session is considered "really opened" only when it has actual history
  // (messages already loaded or known activity on disk). Otherwise the user
  // is on a fresh empty new-chat scratchpad and the "+ 新对话" item should be
  // the highlighted one — not any session row.
  const currentSessionHasContent =
    messages.length > 0
    || !!sessionLastActivity[currentSessionKey]
    || !!sessionLabels[currentSessionKey]
    || !!customSessionLabels[currentSessionKey];
  const isNewChatActive = isOnChat && !currentSessionHasContent;
  const isSessionViewActive = isOnChat && currentSessionHasContent;

  const getSessionLabel = (key: string, displayName?: string, label?: string) =>
    customSessionLabels[key] ?? sessionLabels[key] ?? label ?? displayName ?? key;

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
  const [workspaceToDelete, setWorkspaceToDelete] = useState<{ id: string; label: string } | null>(null);
  const [sessionToRename, setSessionToRename] = useState<{ key: string; label: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (sessionToRename) {
      const id = window.setTimeout(() => {
        renameInputRef.current?.focus();
        renameInputRef.current?.select();
      }, 0);
      return () => window.clearTimeout(id);
    }
  }, [sessionToRename]);

  const closeRenameDialog = () => {
    if (renameSaving) return;
    setSessionToRename(null);
    setRenameDraft('');
  };

  const submitRename = async () => {
    if (!sessionToRename || renameSaving) return;
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      toast.error(t('common:sidebar.renameSessionEmpty'));
      return;
    }
    if (trimmed === sessionToRename.label) {
      closeRenameDialog();
      return;
    }
    setRenameSaving(true);
    try {
      await renameSession(sessionToRename.key, trimmed);
      setSessionToRename(null);
      setRenameDraft('');
    } catch (error) {
      toast.error(`${t('common:sidebar.renameSessionFailed')}: ${toUserMessage(error)}`);
    } finally {
      setRenameSaving(false);
    }
  };

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeRenameDialog();
    }
  };

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

  const renderChatSessionRow = (s: ChatSession, options?: { inWorkspace?: boolean }) => {
    const inWorkspace = options?.inWorkspace === true;
    const agentId = getAgentIdFromSessionKey(s.key);
    const agentName = agentNameById[agentId] || agentId;
    const isCurrent = currentSessionKey === s.key;
    // Per-session running status. For the currently-viewed session, use the
    // live `isChatActive` flag (sending / activeRunId). For other sessions,
    // fall back to the snapshot saved in `sessionStreamingStates` when the
    // user switched away — so a session still streaming in the background
    // keeps its orange indicator no matter which session is being viewed.
    const otherSessionState = sessionStreamingStates[s.key];
    const isOtherSessionRunning =
      !isCurrent && !!(otherSessionState?.sending || otherSessionState?.activeRunId);
    const isRunning = (isCurrent && isChatActive) || isOtherSessionRunning;
    const statusTitle = isRunning
      ? t('chat:sidebar.statusRunning', { defaultValue: '问答进行中' })
      : t('chat:sidebar.statusCompleted', { defaultValue: '已完成' });
    const sessionLabel = getSessionLabel(s.key, s.displayName, s.label);
    return (
      <div key={s.key} className="group relative flex items-center">
        <button
          type="button"
          data-testid={`sidebar-session-${s.key}`}
          onClick={(e) => {
            e.stopPropagation(); // 阻止事件冒泡到工作空间
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
            'w-full text-left rounded-lg py-1.5 text-[13px] transition-[padding,colors]',
            inWorkspace ? 'pl-1.5 pr-1.5 group-hover:pr-[4.25rem]' : 'px-2.5 group-hover:pr-12',
            'hover:bg-white/60 dark:hover:bg-white/10',
            isSessionViewActive && currentSessionKey === s.key
              ? 'bg-white text-[#FF922B] font-medium shadow-sm shadow-black/[0.04] dark:bg-white/10 dark:text-foreground'
              : 'text-foreground/75',
            firstResponsePreparingLocksSwitch && s.key !== currentSessionKey && 'opacity-50 cursor-not-allowed',
          )}
        >
          <div className={cn('flex min-w-0 items-center', inWorkspace ? 'gap-1.5' : 'gap-2')}>
            <span
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
              title={statusTitle}
              aria-label={statusTitle}
              data-testid={`sidebar-session-status-${s.key}`}
              data-status={isRunning ? 'running' : 'completed'}
            >
              {isRunning ? (
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF922B] opacity-60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF922B]" />
                </span>
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" strokeWidth={2.25} />
              )}
            </span>
            <span className="shrink-0 rounded-full bg-black/[0.14] px-2 py-0.5 text-[10px] font-medium text-foreground/70 dark:bg-white/[0.12]">
              {agentName}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 flex-1 truncate text-left">{sessionLabel}</span>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                align="center"
                className="max-w-xs whitespace-normal break-words text-[13px]"
              >
                {sessionLabel}
              </TooltipContent>
            </Tooltip>
          </div>
        </button>
        <div
          className={cn(
            'absolute right-1 flex items-center gap-0.5 transition-opacity',
            'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <button
            type="button"
            aria-label={t('common:sidebar.renameSession')}
            title={t('common:sidebar.renameSession')}
            data-testid={`sidebar-session-rename-${s.key}`}
            onClick={(e) => {
              e.stopPropagation();
              const currentLabel = getSessionLabel(s.key, s.displayName, s.label);
              setSessionToRename({ key: s.key, label: currentLabel });
              setRenameDraft(currentLabel);
            }}
            className="flex items-center justify-center rounded p-0.5 text-[#FF6A00] hover:text-[#FF6A00] hover:bg-[#FF922B]/10 dark:text-primary dark:hover:bg-primary/15 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          {inWorkspace ? (
            <button
              type="button"
              aria-label={t('common:sidebar.removeFromWorkspace')}
              title={t('common:sidebar.removeFromWorkspace')}
              data-testid={`sidebar-session-remove-workspace-${s.key}`}
              onClick={(e) => {
                e.stopPropagation();
                unbindSessionWorkspace(s.key);
                toast.success(t('common:sidebar.removeFromWorkspaceSuccess'));
              }}
              className="flex items-center justify-center rounded p-0.5 text-[#FF6A00] hover:text-[#FF6A00] hover:bg-[#FF922B]/10 dark:text-primary dark:hover:bg-primary/15 transition-colors"
            >
              <FolderOutput className="h-3.5 w-3.5" />
            </button>
          ) : null}
          <button
            type="button"
            aria-label={t('common:actions.delete')}
            title={t('common:actions.delete')}
            onClick={(e) => {
              e.stopPropagation();
              setSessionToDelete({
                key: s.key,
                label: getSessionLabel(s.key, s.displayName, s.label),
              });
            }}
            className="flex items-center justify-center rounded p-0.5 text-[#FF6A00] hover:text-[#FF6A00] hover:bg-[#FF922B]/10 dark:text-primary dark:hover:bg-primary/15 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
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
    if (isPendingNewSession(session.key)) continue;
    const bucketKey = getSessionBucket(sessionLastActivity[session.key] ?? 0, nowMs);
    sessionBucketMap[bucketKey].sessions.push(session);
  }

  const hiddenRoutes = rendererExtensionRegistry.getHiddenRoutes();
  const extraNavItems = rendererExtensionRegistry.getExtraNavItems();

  const coreNavItems = [
    { to: '/cron', icon: <Clock className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.cronTasks'), testId: 'sidebar-nav-cron' },
    { to: '/models', icon: <Cpu className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.models'), testId: 'sidebar-nav-models' },
    { to: '/agents', icon: <Bot className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.agents'), testId: 'sidebar-nav-agents' },
    { to: '/skills', icon: <Puzzle className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.skills'), testId: 'sidebar-nav-skills' },
    { to: '/channels', icon: <Network className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.channels'), testId: 'sidebar-nav-channels' },
    { to: '/connectors', icon: <Link2 className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.connectors'), testId: 'sidebar-nav-connectors' },
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
    <>
    <aside
      data-testid="sidebar"
      className={cn(
        'flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-[#f5e4d6] bg-[linear-gradient(177deg,_#FFF1EB_0.66%,_#FFFAF6_99.87%)] dark:border-border dark:bg-background dark:bg-none transition-all duration-300',
        sidebarCollapsed ? 'w-16' : 'w-64'
      )}
    >
      {/* Top Header Toggle */}
      <div className={cn("flex items-center p-2 h-12", sidebarCollapsed ? "justify-center" : "justify-between")}>
        {!sidebarCollapsed && (
          <div className="flex items-center gap-2 px-2 overflow-hidden">
            <img src={logoSvg} alt="LYClaw" className="h-5 w-auto shrink-0" />
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold truncate whitespace-nowrap text-foreground/90">
                LYClaw
              </span>
              <span className="text-[10px] font-medium text-muted-foreground/70">
                v{version}
                {shouldShowUpdateAvailableBadge(updateStatus) && (
                  <span className="text-red-500 font-medium">
                    {t('common:sidebar.updateAvailable')}
                  </span>
                )}
              </span>
            </div>
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
            // Always create a fresh empty session so the user lands on the
            // welcome screen regardless of which page they were on or what
            // history the previously-selected session still has on disk.
            if (blockSessionSwitchIfFirstResponsePreparing()) return;
            const { messages: ms, currentSessionKey: ck, sessionLastActivity: sla, sessionLabels: sl } =
              useChatStore.getState();
            const currentIsAlreadyFreshEmpty =
              ms.length === 0 && !sla[ck] && !sl[ck];
            if (!currentIsAlreadyFreshEmpty || ck.endsWith(':main')) {
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
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium transition-all mb-2 border border-transparent',
            isNewChatActive
              ? 'bg-white text-[#FF922B] shadow-sm shadow-black/[0.04] hover:bg-white/80 dark:bg-accent dark:text-foreground dark:shadow-none'
              : 'text-foreground/80 hover:bg-white/60 hover:shadow-sm dark:hover:bg-white/10',
            sidebarCollapsed && 'justify-center px-0',
            firstResponsePreparingLocksSwitch && messages.length > 0 && 'opacity-50 cursor-not-allowed',
          )}
        >
          <div
            className={cn(
              'flex shrink-0 items-center justify-center',
              isNewChatActive ? 'text-[#FF922B] dark:text-foreground/80' : 'text-muted-foreground',
            )}
          >
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
      {/* Session list */}
      {!sidebarCollapsed && (
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-2 pt-4">
          {/* Workspaces */}
          {allWorkspaces.length > 0 && (
            <div data-testid="sidebar-workspaces-section" className="pb-2">
              <div
                className="flex items-center justify-between px-2.5 py-2 cursor-pointer hover:bg-white dark:hover:bg-white/10 rounded-lg"
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
                    .slice()
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .map((workspace) => {
                      const displayName = workspace.name;
                      const sessionCount = sessionsByWorkspaceId[workspace.id]?.length ?? 0;
                      const chatsExpanded =
                        sessionCount > 0 && !workspaceChatsCollapsedIds.has(workspace.id);
                      const isActiveWorkspace = activeWorkspaceId === workspace.id;

                      const handleWorkspaceBodyClick = () => {
                        if (sessionCount === 0) return;
                        toggleWorkspaceChatsCollapsed(workspace.id);
                      };

                      return (
                        <div key={workspace.id}>
                          <div
                            data-testid={`sidebar-workspace-row-${workspace.id}`}
                            className={cn(
                              'w-full text-left rounded-lg px-2.5 py-1.5 text-[13px] transition-colors flex items-center gap-1 cursor-pointer group',
                              'hover:bg-white/60 dark:hover:bg-white/10',
                              isActiveWorkspace
                                ? 'bg-white text-[#FF922B] font-medium shadow-sm shadow-black/[0.04] dark:bg-white/10 dark:text-foreground'
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
                              {chatsExpanded ? (
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
                                data-testid={`sidebar-workspace-remove-${workspace.id}`}
                                className="flex shrink-0 items-center justify-center w-5 h-5 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  setWorkspaceToDelete({ id: workspace.id, label: displayName });
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
                              className="mt-0.5 ml-1"
                            >
                              {chatsExpanded ? (
                                <div className="space-y-0.5 overflow-y-auto overflow-x-hidden scrollbar-thin">
                                  {sessionsByWorkspaceId[workspace.id]!.map((session) =>
                                    renderChatSessionRow(session, { inWorkspace: true }),
                                  )}
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

          {/* Session list — below workspaces */}
          {sessions.some((s) => !isSessionListedUnderWorkspace(s.key) && !isPendingNewSession(s.key)) && (
            <div className="space-y-0.5">
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
                    'flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[14px] font-medium text-[#FF922B] transition-colors hover:bg-[#FF922B]/10 disabled:opacity-60',
                    sidebarCollapsed ? 'justify-center px-0 w-10 h-10' : 'text-left w-full'
                  )}
                >
                  <div className="flex shrink-0 items-center justify-center text-[#FF922B]">
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
                !isActive && 'hover:bg-white/60 dark:hover:bg-white/10 text-foreground/80',
                isActive && 'bg-white text-[#FF922B] shadow-sm shadow-black/[0.04] dark:bg-white/10 dark:text-foreground',
                sidebarCollapsed ? 'justify-center px-0 w-full' : ''
              )
            }
          >
          {({ isActive }) => (
            <>
              <div className={cn("flex shrink-0 items-center justify-center", isActive ? "text-[#FF922B] dark:text-foreground" : "text-muted-foreground")}>
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
    </aside>

      <ConfirmDialog
        open={!!sessionToDelete}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteSessionConfirm', { label: sessionToDelete?.label ?? '' })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        testId="sidebar-session-delete-confirm"
        onConfirm={async () => {
          if (!sessionToDelete) return;
          await deleteSession(sessionToDelete.key);
          if (currentSessionKey === sessionToDelete.key) navigate('/');
          setSessionToDelete(null);
        }}
        onCancel={() => setSessionToDelete(null)}
      />

      <ConfirmDialog
        open={!!workspaceToDelete}
        title={t('common:actions.confirm')}
        message={t('common:sidebar.deleteWorkspaceConfirm', { label: workspaceToDelete?.label ?? '' })}
        confirmLabel={t('common:actions.delete')}
        cancelLabel={t('common:actions.cancel')}
        variant="destructive"
        testId="sidebar-workspace-delete-confirm"
        onConfirm={() => {
          if (!workspaceToDelete) return;
          const workspaceId = workspaceToDelete.id;
          removeTemporaryWorkspace(workspaceId);
          clearSessionWorkspaceBindings(workspaceId);
          setWorkspaceToDelete(null);
          void flushUiStateSync().catch((error) => {
            console.warn('[sidebar] Failed to persist workspace removal:', error);
          });
        }}
        onCancel={() => setWorkspaceToDelete(null)}
      />

      {sessionToRename && (
        <ModalOverlay
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-session-title"
          data-testid="sidebar-session-rename-dialog"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              closeRenameDialog();
            }
          }}
        >
          <div
            className="mx-4 w-full max-w-md rounded-lg border bg-card p-6 shadow-lg focus:outline-none"
            tabIndex={-1}
          >
            <h2 id="rename-session-title" className="text-lg font-semibold">
              {t('common:sidebar.renameSessionTitle')}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('common:sidebar.renameSessionDescription')}
            </p>
            <div className="mt-4">
              <Input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onKeyDown={handleRenameKeyDown}
                placeholder={t('common:sidebar.renameSessionPlaceholder')}
                maxLength={120}
                disabled={renameSaving}
                data-testid="sidebar-session-rename-input"
              />
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={closeRenameDialog}
                disabled={renameSaving}
                data-testid="sidebar-session-rename-cancel"
                className="h-8 text-[13px] font-medium rounded-lg px-3 border-black/10 dark:border-white/10 bg-white dark:bg-transparent hover:bg-black/5 dark:hover:bg-white/5 text-foreground/80 hover:text-foreground transition-colors"
              >
                {t('common:actions.cancel')}
              </Button>
              <Button
                onClick={() => void submitRename()}
                disabled={renameSaving || !renameDraft.trim()}
                data-testid="sidebar-session-rename-save"
                className="h-8 text-[13px] font-medium rounded-lg px-3 bg-[#FF922B] hover:bg-[#FF6A00] text-white shadow-sm"
              >
                {renameSaving ? t('common:status.saving') : t('common:actions.save')}
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}
    </>
  );
}
