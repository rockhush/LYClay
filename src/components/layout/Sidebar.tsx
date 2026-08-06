/**
 * Sidebar Component
 * Navigation sidebar with menu items.
 * No longer fixed - sits inside the flex layout below the title bar.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { version } from '@/../package.json';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import {
  Network,
  Briefcase,
  Puzzle,
  Link2,
  Clock,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeft,
  Plus,
  ExternalLink,
  Cpu,
  Wrench,
  Folder,
  FolderOpen,
  ChevronRight,
  Loader2,
  X,
  Search,
  ListFilter,
  LogOut,
  User,
  MoreHorizontal,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { rendererExtensionRegistry } from '@/extensions/registry';
import { useSettingsStore } from '@/stores/settings';
import { useChatStore, type ChatSession } from '@/stores/chat';
import {
  deriveIsExecuting,
  deriveSidebarSessionIsExecuting,
  backendActivityForSession,
} from '@/stores/chat/user-turn-lifecycle';
import { ensureSessionBackendPolling } from '@/stores/chat/session-backend-bridge';
import { isParentDelegationPhaseOpen } from '@/lib/delegation-turn-state';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { useDigitalEmployeesStore } from '@/stores/digital-employees';
import { resolveAgentDisplayName } from '@/lib/retired-digital-employees';
import { useTokenUsageStore } from '@/stores/token-usage';
import { useWorkspacesStore } from '@/stores/workspaces';
import { useSkillsStore } from '@/stores/skills';
import { useDingTalkAuthStore } from '@/stores/dingtalk-auth';
import { useUpdateStore, shouldShowUpdateAvailableBadge } from '@/stores/update';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { flushUiStateSync } from '@/lib/ui-state-persistence';
import { invokeIpc, toUserMessage } from '@/lib/api-client';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { isFirstResponsePreparing } from '@/lib/chat-first-response-preparing';
import {
  buildStableSessionOrder,
  getSessionBucket,
  resolveSessionActivityMs,
  shouldHideStaleSessionFromSidebar,
  type SessionBucketKey,
} from '@/lib/session-sidebar-order';
import { buildBatchDeleteSessionGroups } from '@/lib/session-batch-delete-groups';
import { BatchDeleteSessionsDialog } from '@/components/chat/BatchDeleteSessionsDialog';
import { SidebarMoreNavPanel } from '@/components/layout/SidebarMoreNavPanel';
import { SidebarSessionRow } from '@/components/layout/SidebarSessionRow';
import { SidebarSessionFilterPopover } from '@/components/layout/SidebarSessionFilterPopover';
import { whenUiStateHydrated } from '@/lib/ui-state-persistence';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import {
  matchesSidebarSessionCategoryFilter,
  type SidebarSessionCategoryFilter,
} from '@/lib/session-category-filter';
import { isUserFacingSessionKey } from '@/lib/session-key-utils';
import { resolveSessionDisplayLabel, isPlaceholderSessionTitle } from '@/lib/session-label-utils';
import {
  formatCronSessionDisplayLabel,
  hasCronBracketLabel,
  isCronSessionKey,
  parseCronSessionKey,
  resolveCronBracketJobId,
} from '@/stores/chat/cron-session-utils';
import { useCronStore } from '@/stores/cron';
import logoSvg from '@/assets/1.png';

type HistorySectionKey = 'pinned' | SessionBucketKey;

/** History buckets collapsed by default (Set membership = collapsed). */
const DEFAULT_COLLAPSED_HISTORY_SECTIONS: HistorySectionKey[] = [
  'withinWeek',
  'withinTwoWeeks',
  'withinMonth',
  'older',
];

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

interface NavItemProps {
  to: string;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  collapsed?: boolean;
  end?: boolean;
  onClick?: () => void;
  testId?: string;
}

function NavItem({ to, icon, label, badge, collapsed, end, onClick, testId }: NavItemProps) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onClick}
      data-testid={testId}
      className={({ isActive }) =>
        cn(
          'group flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium transition-all',
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

const INITIAL_NOW_MS = Date.now();

function getAgentIdFromSessionKey(sessionKey: string): string {
  if (!sessionKey.startsWith('agent:')) return 'main';
  const [, agentId] = sessionKey.split(':');
  return agentId || 'main';
}

const STARTUP_LOAD_SESSIONS_DELAY_MS = 0;
const STARTING_FALLBACK_LOAD_SESSIONS_DELAY_MS = 5_000;

export function Sidebar() {
  const { t } = useTranslation(['common', 'chat', 'settings', 'cron']);
  const sidebarCollapsed = useSettingsStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useSettingsStore((state) => state.setSidebarCollapsed);

  const cronJobs = useCronStore((s) => s.jobs);
  const cronJobNamesById = useMemo(
    () => new Map(cronJobs.map((job) => [job.id, job.name])),
    [cronJobs],
  );

  const sessions = useChatStore((s) => s.sessions);
  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const sessionLabels = useChatStore((s) => s.sessionLabels);
  const customSessionLabels = useChatStore((s) => s.customSessionLabels);
  const sessionLastActivity = useChatStore((s) => s.sessionLastActivity);
  const sessionWorkspaceIds = useChatStore((s) => s.sessionWorkspaceIds);
  const sessionPinnedAt = useChatStore((s) => s.sessionPinnedAt);
  const sessionStreamingStates = useChatStore((s) => s.sessionStreamingStates);
  const switchSession = useChatStore((s) => s.switchSession);
  const newSession = useChatStore((s) => s.newSession);
  const bindCurrentSessionWorkspace = useChatStore((s) => s.bindCurrentSessionWorkspace);
  const clearSessionWorkspaceBindings = useChatStore((s) => s.clearSessionWorkspaceBindings);
  const unbindSessionWorkspace = useChatStore((s) => s.unbindSessionWorkspace);
  const toggleSessionPinned = useChatStore((s) => s.toggleSessionPinned);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const renameSession = useChatStore((s) => s.renameSession);
  const loadSessions = useChatStore((s) => s.loadSessions);
  const chatSending = useChatStore((s) => s.sending);
  const activeRunId = useChatStore((s) => s.activeRunId);
  const pendingFinal = useChatStore((s) => s.pendingFinal);
  const runAborted = useChatStore((s) => s.runAborted);
  const lastUserMessageAt = useChatStore((s) => s.lastUserMessageAt);
  const messageCount = useChatStore((s) => s.messages.length);
  const messages = useChatStore((s) => s.messages);
  const streamingMessage = useChatStore((s) => s.streamingMessage);
  const skills = useSkillsStore((s) => s.skills);
  const fetchSkills = useSkillsStore((s) => s.fetchSkills);
  const sessionBackendActivity = useChatStore((s) => s.sessionBackendActivity);
  const gatewayBackgroundActivity = useChatStore((s) => s.gatewayBackgroundActivity);
  const waitingOnSubagentDelegation = useChatStore((s) => isParentDelegationPhaseOpen(
    s.messages,
    s.gatewayBackgroundActivity?.processingSessionKeys ?? [],
    {
      lastUserMessageAt: s.lastUserMessageAt,
      streamingMessage: s.streamingMessage,
    },
  ));

  const gatewayStatus = useGatewayStore((s) => s.status);
  const isGatewayRunning = gatewayStatus.state === 'running';
  const isGatewayReady = isGatewayRunning && gatewayStatus.gatewayReady === true;
  const updateStatus = useUpdateStore((s) => s.status);
  const checkForUpdatesAfterGatewayReady = useUpdateStore((s) => s.checkForUpdatesAfterGatewayReady);
  const isChatActive = useChatStore((s) => deriveIsExecuting(
    { sending: s.sending, activeRunId: s.activeRunId, pendingFinal: s.pendingFinal, runAborted: s.runAborted },
    backendActivityForSession(s.sessionBackendActivity, currentSessionKey),
    {
      waitingOnSubagentDelegation: isParentDelegationPhaseOpen(
        s.messages,
        s.gatewayBackgroundActivity?.processingSessionKeys ?? [],
        {
          lastUserMessageAt: s.lastUserMessageAt,
          streamingMessage: s.streamingMessage,
        },
      ),
      gatewayBackground: s.gatewayBackgroundActivity,
      messages: s.messages,
      lastUserMessageAt: s.lastUserMessageAt,
      streamingMessage: s.streamingMessage,
      sessionKey: currentSessionKey,
    },
  ));

  const firstResponsePreparingLocksSwitch = useChatStore((s) => isFirstResponsePreparing({
    gatewayStatus,
    sending: s.sending,
    streamingMessage: s.streamingMessage,
    streamingText: s.streamingText,
    streamingTools: s.streamingTools,
  }));

  useEffect(() => {
    if (!isGatewayRunning || !currentSessionKey) return;
    ensureSessionBackendPolling(currentSessionKey, useChatStore.setState, useChatStore.getState);
  }, [isGatewayRunning, currentSessionKey]);

  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const temporaryWorkspaces = useWorkspacesStore((s) => s.temporaryWorkspaces);
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

  /**
   * The session entry for a freshly-clicked "+ 新对话" that hasn't sent any
   * messages yet is hidden from the sidebar lists. It only shows up once the
   * user actually sends a message (which assigns activity / messages).
   */
  const isPendingNewSession = (sessionKey: string): boolean => {
    if (sessionKey !== currentSessionKey) return false;
    if (messageCount > 0) return false;
    if (sessionLastActivity[sessionKey]) return false;
    if (sessionLabels[sessionKey]) return false;
    if (customSessionLabels[sessionKey]) return false;

    const session = sessions.find((item) => item.key === sessionKey);
    if (session?.label?.trim()) return false;
    if (session?.firstUserMessagePreview?.trim()) return false;
    if (session?.displayName?.trim() && session.displayName !== sessionKey) return false;
    if (typeof session?.updatedAt === 'number' && session.updatedAt > 0) return false;
    return true;
  };

  /**
   * Whether a session has a real, user-meaningful title. Real conversations
   * always resolve to a custom label, first-user-message preview, or a
   * backend-provided display name. An "empty" session (e.g. the `:main`
   * scratchpad or a never-sent new chat) only resolves to its raw key.
   */
  const sessionHasRealTitle = (session: ChatSession): boolean => {
    const key = session.key;
    if (customSessionLabels[key]?.trim()) return true;
    if (sessionLabels[key]?.trim()) return true;
    if (session.firstUserMessagePreview?.trim()) return true;
    if (session.label?.trim() && !isPlaceholderSessionTitle(session.label)) return true;
    if (session.displayName?.trim() && session.displayName !== key && !isPlaceholderSessionTitle(session.displayName)) {
      return true;
    }
    return false;
  };

  /**
   * Empty scratchpad/ghost sessions (no messages ever sent) must not pollute the
   * history list. We key off the absence of a real title rather than activity
   * timestamps, because the `:main` scratchpad can carry an `updatedAt` from
   * warmup/visits while never holding actual conversation content.
   */
  const isEmptyGhostSession = (session: ChatSession): boolean => {
    if (sessionHasRealTitle(session)) return false;
    // Keep the active conversation visible while its label is still hydrating.
    if (session.key === currentSessionKey && messageCount > 0) return false;
    // Respect explicit user intent to keep a pinned session around.
    if (Number.isFinite(sessionPinnedAt[session.key]) && sessionPinnedAt[session.key] > 0) return false;
    return true;
  };

  const isSessionListedUnderWorkspace = (sessionKey: string) => {
    const wid = sessionWorkspaceIds[sessionKey];
    return Boolean(wid && workspaceIdsKnown.has(wid));
  };

  const [nowMs, setNowMs] = useState(INITIAL_NOW_MS);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  const stableSessionOrderRef = useRef<string[]>([]);

  const orderedSidebarSessions = useMemo(() => {
    const eligible = sessions.filter(
      (session) =>
        isUserFacingSessionKey(session.key)
        && !isPendingNewSession(session.key)
        && !isEmptyGhostSession(session)
        && !shouldHideStaleSessionFromSidebar({
          sessionKey: session.key,
          activityMs: resolveSessionActivityMs(session, sessionLastActivity),
          nowMs,
          firstUserMessagePreview: session.firstUserMessagePreview,
          label: session.label,
          displayName: session.displayName,
          sessionLabel: sessionLabels[session.key],
          customLabel: customSessionLabels[session.key],
        }),
    );
    const nextOrder = buildStableSessionOrder(
      eligible,
      sessionLastActivity,
      stableSessionOrderRef.current,
    );
    stableSessionOrderRef.current = nextOrder;
    const sessionByKey = new Map(eligible.map((session) => [session.key, session]));
    return nextOrder
      .map((key) => sessionByKey.get(key))
      .filter((session): session is ChatSession => session != null);
    // sessionLastActivity is read only when seeding/appending newcomers; omitting it
    // from deps keeps existing rows pinned while browsing history.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- isPendingNewSession deps listed below
  }, [sessions, sessionLabels, customSessionLabels, currentSessionKey, messageCount, sessionLastActivity, nowMs]);

  const pinnedSidebarSessions = useMemo(() => {
    return orderedSidebarSessions
      .filter((session) => Number.isFinite(sessionPinnedAt[session.key]) && sessionPinnedAt[session.key] > 0)
      .sort((a, b) => {
        const pinnedDiff = sessionPinnedAt[b.key] - sessionPinnedAt[a.key];
        if (pinnedDiff !== 0) return pinnedDiff;
        return resolveSessionActivityMs(b, sessionLastActivity) - resolveSessionActivityMs(a, sessionLastActivity);
      });
  }, [orderedSidebarSessions, sessionLastActivity, sessionPinnedAt]);

  const unpinnedSidebarSessions = useMemo(
    () => orderedSidebarSessions.filter((session) => !(Number.isFinite(sessionPinnedAt[session.key]) && sessionPinnedAt[session.key] > 0)),
    [orderedSidebarSessions, sessionPinnedAt],
  );

  const sessionsByWorkspaceId = useMemo(() => {
    const map: Record<string, ChatSession[]> = Object.fromEntries(
      allWorkspaces.map((workspace) => [workspace.id, [] as ChatSession[]]),
    );
    for (const session of [...pinnedSidebarSessions, ...unpinnedSidebarSessions]) {
      const wid = sessionWorkspaceIds[session.key];
      if (wid && workspaceIdsKnown.has(wid)) {
        const list = map[wid];
        if (list) list.push(session);
      }
    }
    return map;
  }, [allWorkspaces, pinnedSidebarSessions, sessionWorkspaceIds, unpinnedSidebarSessions, workspaceIdsKnown]);

  const activeWorkspaceId = sessionWorkspaceIds[currentSessionKey] ?? null;

  // 工作空间区域折叠状态
  const [workspacesCollapsed, setWorkspacesCollapsed] = useState(false);
  /** Workspace ids whose per-workspace chat list is collapsed (default: expanded). */
  const [workspaceChatsCollapsedIds, setWorkspaceChatsCollapsedIds] = useState<Set<string>>(
    () => new Set(),
  );
  /** History section keys collapsed in the sidebar (default: withinWeek through older). */
  const [historySectionsCollapsed, setHistorySectionsCollapsed] = useState<Set<HistorySectionKey>>(
    () => new Set(DEFAULT_COLLAPSED_HISTORY_SECTIONS),
  );
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement | null>(null);
  const [openSessionMenuKey, setOpenSessionMenuKey] = useState<string | null>(null);
  const [sessionMenuAnchor, setSessionMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const sessionMenuRef = useRef<HTMLDivElement | null>(null);

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

  const isHistorySectionExpanded = (key: HistorySectionKey) => !historySectionsCollapsed.has(key);

  const toggleHistorySection = (key: HistorySectionKey) => {
    setHistorySectionsCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    if (isGatewayReady) {
      if (isChatActive) {
        return () => {
          cancelled = true;
          if (timer) {
            clearTimeout(timer);
          }
        };
      }

      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          await whenUiStateHydrated();
          if (cancelled) return;
          await loadSessions(true);
        })();
      }, STARTUP_LOAD_SESSIONS_DELAY_MS);
    } else if (gatewayStatus.state === 'starting') {
      timer = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          await whenUiStateHydrated();
          if (cancelled) return;
          await loadSessions(true);
        })();
      }, STARTING_FALLBACK_LOAD_SESSIONS_DELAY_MS);
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
  const digitalEmployees = useDigitalEmployeesStore((s) => s.employees);
  const fetchAgents = useAgentsStore((s) => s.fetchAgents);
  const fetchTokenUsageHistory = useTokenUsageStore((s) => s.fetchTokenUsageHistory);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  useEffect(() => {
    if (skills.length === 0) {
      void fetchSkills();
    }
  }, [skills.length, fetchSkills]);

  useEffect(() => {
    void fetchTokenUsageHistory();
  }, [fetchTokenUsageHistory]);

  const navigate = useNavigate();
  const location = useLocation();
  const isOnChat = location.pathname === '/';

  const handleWorkspaceNewSession = useCallback((workspaceId: string) => {
    newSession();
    bindCurrentSessionWorkspace(workspaceId);
    setCurrentWorkspace(workspaceId);
    navigate('/');
  }, [bindCurrentSessionWorkspace, navigate, newSession, setCurrentWorkspace]);

  const [moreNavOpen, setMoreNavOpen] = useState(false);
  const [moreNavAnchor, setMoreNavAnchor] = useState<{ top: number; left: number } | null>(null);
  const moreNavMenuRef = useRef<HTMLDivElement | null>(null);
  const closeMoreNav = useCallback(() => {
    setMoreNavOpen(false);
    setMoreNavAnchor(null);
  }, []);

  // Distinguish "+ 新对话" active state from "session selected" active state.
  // A session is considered "really opened" only when it has actual history
  // (messages already loaded or known activity on disk). Otherwise the user
  // is on a fresh empty new-chat scratchpad and the "+ 新对话" item should be
  // the highlighted one — not any session row.
  const currentSessionHasContent =
    messageCount > 0
    || !!sessionLastActivity[currentSessionKey]
    || !!sessionLabels[currentSessionKey]
    || !!customSessionLabels[currentSessionKey];
  const isNewChatActive = isOnChat && !currentSessionHasContent;
  const isSessionViewActive = isOnChat && currentSessionHasContent;

  const getSessionLabel = useCallback((session: ChatSession) => {
    const resolved = resolveSessionDisplayLabel({
      sessionKey: session.key,
      customLabel: customSessionLabels[session.key],
      sessionLabel: sessionLabels[session.key],
      firstUserMessagePreview: session.firstUserMessagePreview,
      label: session.label,
      displayName: session.displayName,
      skills,
    });
    const cronFallback = t('cron:title', { defaultValue: '定时任务' });
    if (isCronSessionKey(session.key)) {
      const jobId = parseCronSessionKey(session.key)?.jobId;
      const jobName = jobId ? cronJobNamesById.get(jobId) : undefined;
      return formatCronSessionDisplayLabel(resolved, {
        jobName,
        fallback: cronFallback,
      });
    }
    if (hasCronBracketLabel(resolved)) {
      const bracketJobId = resolveCronBracketJobId(resolved);
      const jobName = bracketJobId ? cronJobNamesById.get(bracketJobId) : undefined;
      return formatCronSessionDisplayLabel(resolved, {
        jobName,
        fallback: cronFallback,
      });
    }
    return resolved;
  }, [customSessionLabels, sessionLabels, cronJobNamesById, skills, t]);

  /* OpenClaw 控制台入口暂时隐藏
  const openDevConsole = async () => {
    try {
      const result = await hostApiFetch<{
        success: boolean;
        url?: string;
        error?: string;
      }>('/api/gateway/control-ui');
      if (result.success && result.url) {
        await invokeIpc('shell:openExternal', result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };
  */

  const [sessionToDelete, setSessionToDelete] = useState<{ key: string; label: string } | null>(null);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<{ id: string; label: string } | null>(null);
  const [sessionToRename, setSessionToRename] = useState<{ key: string; label: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState('');
  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 200);
  const [sessionCategoryFilter, setSessionCategoryFilter] = useState<SidebarSessionCategoryFilter>('all');
  const [sessionFilterOpen, setSessionFilterOpen] = useState(false);
  const [sessionFilterAnchor, setSessionFilterAnchor] = useState<{ top: number; left: number } | null>(null);
  const sessionFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sessionFilterPanelRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    if (!openSessionMenuKey) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (!sessionMenuRef.current?.contains(event.target as Node)) {
        setOpenSessionMenuKey(null);
        setSessionMenuAnchor(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [openSessionMenuKey]);

  useEffect(() => {
    if (!sessionFilterOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (sessionFilterPanelRef.current?.contains(target)) return;
      if (sessionFilterTriggerRef.current?.contains(target)) return;
      setSessionFilterOpen(false);
      setSessionFilterAnchor(null);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [sessionFilterOpen]);

  useEffect(() => {
    if (!moreNavOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (moreNavMenuRef.current?.contains(target)) return;
      if ((event.target as HTMLElement).closest?.('[data-testid="sidebar-nav-more"]')) return;
      setMoreNavOpen(false);
      setMoreNavAnchor(null);
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [moreNavOpen]);

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

  const renderHistorySectionHeader = (key: HistorySectionKey, label: string, count: number) => {
    const expanded = isHistorySectionExpanded(key);
    return (
      <div className="flex items-center justify-between gap-1 px-2.5 pb-1">
        <button
          type="button"
          className="flex min-w-0 flex-1 cursor-pointer text-left"
          onClick={() => toggleHistorySection(key)}
          aria-expanded={expanded}
        >
          <span
            className="text-[11px] font-medium text-muted-foreground/60 tracking-tight"
            data-testid={`sidebar-history-section-header-${key}`}
          >
            {label}({count})
          </span>
        </button>
        <button
          type="button"
          data-testid={`sidebar-history-section-toggle-${key}`}
          className="flex shrink-0 items-center justify-center cursor-pointer"
          onClick={() => toggleHistorySection(key)}
          aria-expanded={expanded}
        >
          <ChevronRight
            className={cn(
              'h-3 w-3 text-muted-foreground transition-transform',
              expanded && 'rotate-90',
            )}
          />
        </button>
      </div>
    );
  };

  const sessionBuckets = useMemo(() => {
    const buckets: Array<{ key: SessionBucketKey; label: string; sessions: ChatSession[] }> = [
      { key: 'today', label: t('chat:historyBuckets.today'), sessions: [] },
      { key: 'yesterday', label: t('chat:historyBuckets.yesterday'), sessions: [] },
      { key: 'withinWeek', label: t('chat:historyBuckets.withinWeek'), sessions: [] },
      { key: 'withinTwoWeeks', label: t('chat:historyBuckets.withinTwoWeeks'), sessions: [] },
      { key: 'withinMonth', label: t('chat:historyBuckets.withinMonth'), sessions: [] },
      { key: 'older', label: t('chat:historyBuckets.older'), sessions: [] },
    ];
    const bucketMap = Object.fromEntries(buckets.map((bucket) => [bucket.key, bucket])) as Record<
      SessionBucketKey,
      (typeof buckets)[number]
    >;

    for (const session of unpinnedSidebarSessions) {
      if (isSessionListedUnderWorkspace(session.key)) continue;
      const bucketKey = getSessionBucket(resolveSessionActivityMs(session, sessionLastActivity), nowMs);
      bucketMap[bucketKey].sessions.push(session);
    }

    return buckets;
  }, [
    unpinnedSidebarSessions,
    sessionLastActivity,
    nowMs,
    t,
  ]);

  const pinnedHistorySessions = useMemo(
    () => pinnedSidebarSessions.filter((session) => !isSessionListedUnderWorkspace(session.key)),
    [pinnedSidebarSessions, sessionWorkspaceIds, workspaceIdsKnown],
  );

  const normalizedSessionSearchQuery = useMemo(() => {
    if (sessionSearchQuery.trim() === '') return '';
    return debouncedSessionSearchQuery.trim().toLowerCase();
  }, [sessionSearchQuery, debouncedSessionSearchQuery]);
  const isSessionSearchActive = sessionSearchQuery.trim().length > 0;
  const isSessionCategoryFilterActive = sessionCategoryFilter !== 'all';
  const isSessionListQueryActive = isSessionSearchActive || isSessionCategoryFilterActive;

  const agentNameBySessionKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      const agentId = getAgentIdFromSessionKey(session.key);
      map.set(session.key, resolveAgentDisplayName(agentId, { agents, digitalEmployees }));
    }
    return map;
  }, [sessions, agents, digitalEmployees]);

  const sessionFilterLabels = useMemo(() => ({
    category: t('common:sidebar.sessionFilterCategory'),
    all: t('common:sidebar.sessionFilterAll'),
    cron: t('common:sidebar.sessionFilterCron'),
    session: t('common:sidebar.sessionFilterSession'),
  }), [t]);

  const sessionMatchesSearch = useCallback((session: ChatSession) => {
    if (!isSessionSearchActive) return true;
    const query = normalizedSessionSearchQuery;
    const labelMatch = getSessionLabel(session).toLowerCase().includes(query);
    const agentMatch = (agentNameBySessionKey.get(session.key) ?? '').toLowerCase().includes(query);
    return labelMatch || agentMatch;
  }, [getSessionLabel, agentNameBySessionKey, isSessionSearchActive, normalizedSessionSearchQuery]);

  const sessionMatchesListFilters = useCallback((session: ChatSession) => {
    if (!matchesSidebarSessionCategoryFilter(session.key, sessionCategoryFilter)) {
      return false;
    }
    return sessionMatchesSearch(session);
  }, [sessionCategoryFilter, sessionMatchesSearch]);

  const filteredPinnedHistorySessions = useMemo(
    () => {
      if (!isSessionListQueryActive) return pinnedHistorySessions;
      return pinnedHistorySessions.filter(sessionMatchesListFilters);
    },
    [pinnedHistorySessions, isSessionListQueryActive, sessionMatchesListFilters],
  );

  const filteredSessionBuckets = useMemo(() => {
    if (!isSessionListQueryActive) return sessionBuckets;
    return sessionBuckets
      .map((bucket) => ({
        ...bucket,
        sessions: bucket.sessions.filter(sessionMatchesListFilters),
      }))
      .filter((bucket) => bucket.sessions.length > 0);
  }, [sessionBuckets, isSessionListQueryActive, sessionMatchesListFilters]);

  const filteredSessionsByWorkspaceId = useMemo(() => {
    if (!isSessionListQueryActive) return sessionsByWorkspaceId;
    const next: Record<string, ChatSession[]> = {};
    for (const workspace of allWorkspaces) {
      const matched = (sessionsByWorkspaceId[workspace.id] ?? []).filter(sessionMatchesListFilters);
      if (matched.length > 0) {
        next[workspace.id] = matched;
      }
    }
    return next;
  }, [allWorkspaces, sessionsByWorkspaceId, isSessionListQueryActive, sessionMatchesListFilters]);

  const totalWorkspaceSessionCount = useMemo(
    () => Object.values(filteredSessionsByWorkspaceId).reduce((sum, list) => sum + list.length, 0),
    [filteredSessionsByWorkspaceId],
  );

  const hasAnySessionListMatch = useMemo(() => {
    if (!isSessionListQueryActive) return true;
    const workspaceMatches = Object.values(filteredSessionsByWorkspaceId).some((list) => list.length > 0);
    const historyMatches = filteredPinnedHistorySessions.length > 0
      || filteredSessionBuckets.some((bucket) => bucket.sessions.length > 0);
    return workspaceMatches || historyMatches;
  }, [
    isSessionListQueryActive,
    filteredSessionsByWorkspaceId,
    filteredPinnedHistorySessions,
    filteredSessionBuckets,
  ]);

  const sessionLabelByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of sessions) {
      map.set(session.key, getSessionLabel(session));
    }
    return map;
  }, [sessions, getSessionLabel]);

  const sessionIsRunningByKey = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const session of sessions) {
      const isCurrent = currentSessionKey === session.key;
      map.set(session.key, deriveSidebarSessionIsExecuting({
        sessionKey: session.key,
        isCurrent,
        currentUi: { sending: chatSending, activeRunId, pendingFinal, runAborted },
        currentMessages: messages,
        currentLastUserMessageAt: lastUserMessageAt,
        currentStreamingMessage: streamingMessage,
        waitingOnSubagentDelegation,
        sessionBackendActivity,
        gatewayBackground: gatewayBackgroundActivity,
        snapshot: sessionStreamingStates[session.key],
      }));
    }
    return map;
  }, [
    sessions,
    currentSessionKey,
    chatSending,
    activeRunId,
    pendingFinal,
    runAborted,
    messages,
    lastUserMessageAt,
    waitingOnSubagentDelegation,
    sessionBackendActivity,
    gatewayBackgroundActivity,
    sessionStreamingStates,
    streamingMessage,
  ]);

  const handleSessionSelect = useCallback((sessionKey: string) => {
    if (sessionKey === currentSessionKey) {
      navigate('/');
      return;
    }
    if (blockSessionSwitchIfFirstResponsePreparing()) return;
    switchSession(sessionKey);
    navigate('/');
  }, [currentSessionKey, navigate, switchSession]);

  const handleSessionMenuClose = useCallback(() => {
    setOpenSessionMenuKey(null);
    setSessionMenuAnchor(null);
  }, []);

  const closeSessionFilter = useCallback(() => {
    setSessionFilterOpen(false);
    setSessionFilterAnchor(null);
  }, []);

  const handleSessionMenuToggle = useCallback((
    sessionKey: string,
    anchor: { top: number; left: number },
  ) => {
    setOpenSessionMenuKey(sessionKey);
    setSessionMenuAnchor(anchor);
  }, []);

  const handleSessionDelete = useCallback((sessionKey: string, label: string) => {
    setSessionToDelete({ key: sessionKey, label });
  }, []);

  const handleSessionRename = useCallback((sessionKey: string, label: string) => {
    setSessionToRename({ key: sessionKey, label });
    setRenameDraft(label);
  }, []);

  const handleSessionTogglePin = useCallback((sessionKey: string) => {
    toggleSessionPinned(sessionKey);
  }, [toggleSessionPinned]);

  const handleSessionRemoveFromWorkspace = useCallback((sessionKey: string) => {
    unbindSessionWorkspace(sessionKey);
    toast.success(t('common:sidebar.removeFromWorkspaceSuccess'));
  }, [t, unbindSessionWorkspace]);

  const renderChatSessionRow = (s: ChatSession, options?: { inWorkspace?: boolean }) => {
    const inWorkspace = options?.inWorkspace === true;
    const sessionKey = s.key;
    const isCurrent = currentSessionKey === sessionKey;
    const isRunning = sessionIsRunningByKey.get(sessionKey) ?? false;
    const sessionLabel = sessionLabelByKey.get(sessionKey) ?? sessionKey;
    const agentName = agentNameBySessionKey.get(sessionKey) ?? 'main';
    const isPinned = Number.isFinite(sessionPinnedAt[sessionKey]) && sessionPinnedAt[sessionKey] > 0;

    return (
      <SidebarSessionRow
        key={sessionKey}
        sessionKey={sessionKey}
        sessionLabel={sessionLabel}
        agentName={agentName}
        isCurrent={isCurrent}
        isRunning={isRunning}
        isPinned={isPinned}
        isSessionViewActive={isSessionViewActive}
        inWorkspace={inWorkspace}
        firstResponsePreparingLocksSwitch={firstResponsePreparingLocksSwitch}
        isMenuOpen={openSessionMenuKey === sessionKey}
        menuAnchor={openSessionMenuKey === sessionKey ? sessionMenuAnchor : null}
        menuRef={sessionMenuRef}
        pinLabel={isPinned ? t('common:sidebar.unpinSession') : t('common:sidebar.pinSession')}
        statusRunningLabel={t('chat:sidebar.statusRunning', { defaultValue: '问答进行中' })}
        statusCompletedLabel={t('chat:sidebar.statusCompleted', { defaultValue: '已完成' })}
        sessionActionsLabel={t('common:sidebar.sessionActions', { defaultValue: '会话操作' })}
        deleteLabel={t('common:actions.delete')}
        removeFromWorkspaceLabel={t('common:sidebar.removeFromWorkspace')}
        renameLabel={t('common:sidebar.renameSession')}
        sessionSwitchBlockedTitle={i18n.t('chat:sidebar.sessionSwitchBlockedWhilePreparing')}
        onSelect={handleSessionSelect}
        onMenuToggle={handleSessionMenuToggle}
        onMenuClose={handleSessionMenuClose}
        onDelete={handleSessionDelete}
        onRename={handleSessionRename}
        onTogglePin={handleSessionTogglePin}
        onRemoveFromWorkspace={inWorkspace ? handleSessionRemoveFromWorkspace : undefined}
      />
    );
  };

  const prevSessionSearchQueryRef = useRef('');

  useEffect(() => {
    if (!normalizedSessionSearchQuery) {
      prevSessionSearchQueryRef.current = '';
      return;
    }
    if (normalizedSessionSearchQuery === prevSessionSearchQueryRef.current) {
      return;
    }
    prevSessionSearchQueryRef.current = normalizedSessionSearchQuery;

    const workspaceIdsWithMatches = Object.keys(filteredSessionsByWorkspaceId);
    if (workspaceIdsWithMatches.length > 0) {
      setWorkspacesCollapsed(false);
      setWorkspaceChatsCollapsedIds((prev) => {
        const next = new Set(prev);
        for (const workspaceId of workspaceIdsWithMatches) {
          next.delete(workspaceId);
        }
        return next;
      });
    }

    setHistorySectionsCollapsed((prev) => {
      const next = new Set(prev);
      if (filteredPinnedHistorySessions.length > 0) {
        next.delete('pinned');
      }
      for (const bucket of filteredSessionBuckets) {
        if (bucket.sessions.length > 0) {
          next.delete(bucket.key);
        }
      }
      return next;
    });
  }, [
    normalizedSessionSearchQuery,
    filteredSessionsByWorkspaceId,
    filteredPinnedHistorySessions,
    filteredSessionBuckets,
  ]);

  const batchDeleteSessionGroups = useMemo(() => {
    const resolveTitle = (session: ChatSession) =>
      getSessionLabel(session);

    return buildBatchDeleteSessionGroups({
      sessions: orderedSidebarSessions,
      sessionLastActivity,
      sessionWorkspaceIds,
      sessionPinnedAt,
      workspaces: allWorkspaces,
      nowMs,
      resolveTitle,
      workspaceGroupLabel: (name) => t('common:sidebar.batchDeleteWorkspaceGroup', { name }),
      bucketLabels: {
        pinned: t('chat:historyBuckets.pinned'),
        today: t('chat:historyBuckets.today'),
        yesterday: t('chat:historyBuckets.yesterday'),
        withinWeek: t('chat:historyBuckets.withinWeek'),
        withinTwoWeeks: t('chat:historyBuckets.withinTwoWeeks'),
        withinMonth: t('chat:historyBuckets.withinMonth'),
        older: t('chat:historyBuckets.older'),
      },
    });
  }, [
    orderedSidebarSessions,
    sessionLastActivity,
    sessionWorkspaceIds,
    sessionPinnedAt,
    allWorkspaces,
    nowMs,
    t,
    getSessionLabel,
  ]);

  const batchDeleteSessionCount = useMemo(
    () => batchDeleteSessionGroups.reduce((count, group) => count + group.sessions.length, 0),
    [batchDeleteSessionGroups],
  );

  const handleBatchDeleteSessions = useCallback(async (sessionKeys: string[]) => {
    for (const key of sessionKeys) {
      await deleteSession(key);
    }
    if (sessionKeys.includes(currentSessionKey)) {
      navigate('/');
    }
    toast.success(t('common:sidebar.batchDeleteSuccess', { count: sessionKeys.length }));
  }, [currentSessionKey, deleteSession, navigate, t]);

  const renderBatchDeleteButton = (className?: string) => (
    <button
      type="button"
      data-testid="sidebar-batch-delete-sessions"
      disabled={batchDeleteSessionCount === 0}
      onClick={(event) => {
        event.stopPropagation();
        setBatchDeleteOpen(true);
      }}
      aria-label={t('common:sidebar.batchDelete')}
      title={t('common:sidebar.batchDelete')}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors',
        'hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10',
        'disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      <Trash2 className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
    </button>
  );

  const hiddenRoutes = rendererExtensionRegistry.getHiddenRoutes();
  const extraNavItems = rendererExtensionRegistry.getExtraNavItems();

  const coreNavItems = [
    { to: '/cron/digital-employee', icon: <Briefcase className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.digitalEmployee'), testId: 'sidebar-nav-digital-employee', end: true },
    { to: '/skills', icon: <Puzzle className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.skills'), testId: 'sidebar-nav-skills' },
    { to: '/cron', icon: <Clock className="h-[18px] w-[18px]" strokeWidth={2} />, label: t('sidebar.cronTasks'), testId: 'sidebar-nav-cron', end: true },
  ];

  const moreNavItems = [
    { to: '/models', Icon: Cpu, label: t('sidebar.models'), testId: 'sidebar-nav-models' },
    { to: '/ai-tools', Icon: Wrench, label: t('sidebar.aiTools'), testId: 'sidebar-nav-ai-tools' },
    { to: '/channels', Icon: Network, label: t('sidebar.channels'), testId: 'sidebar-nav-channels' },
    { to: '/connectors', Icon: Link2, label: t('sidebar.connectors'), testId: 'sidebar-nav-connectors' },
  ];

  const primaryNavItems = [
    ...coreNavItems.filter((item) => !hiddenRoutes.has(item.to)),
    ...extraNavItems.map((item) => ({
      to: item.to,
      icon: <item.icon className="h-[18px] w-[18px]" strokeWidth={2} />,
      label: item.labelI18nKey ? t(item.labelI18nKey) : item.label,
      testId: item.testId,
    })),
  ];

  const visibleMoreNavItems = moreNavItems.filter((item) => !hiddenRoutes.has(item.to));
  const isMoreNavActive = visibleMoreNavItems.some(
    (item) => location.pathname === item.to || location.pathname.startsWith(`${item.to}/`),
  );

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

      {!sidebarCollapsed && (
        <div className="px-2 pb-2 pt-0">
          <div className="ml-2 flex h-8 w-[calc(100%-0.9rem)] items-center gap-1">
            <div className="relative flex h-8 min-w-0 flex-1 items-center rounded-lg border-0 bg-white px-3 transition-colors dark:bg-muted">
              <Search className="h-3.5 w-3.5 shrink-0 text-[#FF922B]" />
              <input
                type="text"
                data-testid="sidebar-session-search"
                placeholder={t('common:sidebar.searchSessions')}
                value={sessionSearchQuery}
                onChange={(event) => setSessionSearchQuery(event.target.value)}
                className="ml-2 w-full min-w-0 bg-transparent text-[13px] text-foreground outline-none placeholder:text-foreground/40"
              />
              {sessionSearchQuery ? (
                <button
                  type="button"
                  data-testid="sidebar-session-search-clear"
                  aria-label={t('common:sidebar.clearSessionSearch')}
                  onClick={() => setSessionSearchQuery('')}
                  className="ml-1 shrink-0 text-foreground/40 transition-colors hover:text-foreground/70"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
            <button
              ref={sessionFilterTriggerRef}
              type="button"
              data-testid="sidebar-session-filter-trigger"
              aria-label={t('common:sidebar.sessionFilter')}
              aria-expanded={sessionFilterOpen}
              onClick={(event) => {
                if (sessionFilterOpen) {
                  setSessionFilterOpen(false);
                  setSessionFilterAnchor(null);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setSessionFilterAnchor({
                  top: rect.top,
                  left: rect.right + 6,
                });
                setSessionFilterOpen(true);
              }}
              className={cn(
                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white transition-colors dark:bg-muted',
                isSessionCategoryFilterActive
                  ? 'text-[#FF922B] ring-1 ring-[#FF922B]/30'
                  : 'text-[#FF922B] hover:bg-black/[0.03] dark:hover:bg-white/10',
              )}
            >
              <ListFilter className="h-3.5 w-3.5" />
            </button>
            <SidebarSessionFilterPopover
              open={sessionFilterOpen}
              anchor={sessionFilterAnchor}
              value={sessionCategoryFilter}
              panelRef={sessionFilterPanelRef}
              labels={sessionFilterLabels}
              onChange={(value) => {
                setSessionCategoryFilter(value);
                closeSessionFilter();
              }}
            />
          </div>
        </div>
      )}

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
            const {
              messages: ms,
              currentSessionKey: ck,
              sessionLastActivity: sla,
              sessionLabels: sl,
              prefilledInput,
            } = useChatStore.getState();
            const currentIsAlreadyFreshEmpty =
              ms.length === 0 && !sla[ck] && !sl[ck];
            const isMainAgentSession = getAgentIdFromSessionKey(ck) === 'main';
            if (
              !isOnChat
              || !currentIsAlreadyFreshEmpty
              || ck.endsWith(':main')
              || prefilledInput
              || !isMainAgentSession
            ) {
              newSession();
            }
            navigate('/');
          }}
          disabled={firstResponsePreparingLocksSwitch && messageCount > 0}
          title={
            firstResponsePreparingLocksSwitch && messageCount > 0
              ? i18n.t('chat:sidebar.sessionSwitchBlockedWhilePreparing')
              : undefined
          }
          className={cn(
            'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium transition-all border border-transparent',
            isNewChatActive
              ? 'bg-white text-[#FF922B] shadow-sm shadow-black/[0.04] hover:bg-white/80 dark:bg-accent dark:text-foreground dark:shadow-none'
              : 'text-foreground/80 hover:bg-white/60 hover:shadow-sm dark:hover:bg-white/10',
            sidebarCollapsed && 'justify-center px-0',
            firstResponsePreparingLocksSwitch && messageCount > 0 && 'opacity-50 cursor-not-allowed',
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

        {primaryNavItems.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            collapsed={sidebarCollapsed}
          />
        ))}

        {visibleMoreNavItems.length > 0 && (
          <button
            type="button"
            data-testid="sidebar-nav-more"
            aria-expanded={moreNavOpen}
            title={sidebarCollapsed ? t('sidebar.more') : undefined}
            onClick={(e) => {
              if (moreNavOpen) {
                setMoreNavOpen(false);
                setMoreNavAnchor(null);
                return;
              }
              const rect = e.currentTarget.getBoundingClientRect();
              setMoreNavAnchor({
                top: rect.top + rect.height / 2,
                left: rect.right + 4,
              });
              setMoreNavOpen(true);
            }}
            className={cn(
              'group flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium transition-all',
              !isMoreNavActive &&
                'hover:bg-white/60 hover:shadow-sm dark:hover:bg-white/10 dark:hover:shadow-md dark:hover:shadow-white/[0.12]',
              isMoreNavActive
                ? 'bg-white text-[#FF922B] shadow-sm shadow-black/[0.04] dark:bg-white/10 dark:text-foreground dark:shadow-none'
                : 'text-foreground/80',
              sidebarCollapsed && 'justify-center px-0',
            )}
          >
            <div
              className={cn(
                'flex shrink-0 items-center justify-center transition-colors',
                isMoreNavActive ? 'text-[#FF922B] dark:text-foreground' : 'text-muted-foreground',
              )}
            >
              <MoreHorizontal className="h-[18px] w-[18px]" strokeWidth={2} />
            </div>
            {!sidebarCollapsed && (
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-left">
                {t('sidebar.more')}
              </span>
            )}
          </button>
        )}
      </nav>

      <SidebarMoreNavPanel
        open={moreNavOpen}
        anchor={moreNavAnchor}
        menuRef={moreNavMenuRef}
        onOpenChange={(open) => {
          if (!open) closeMoreNav();
        }}
        items={visibleMoreNavItems.map((item) => ({
          to: item.to,
          label: item.label,
          testId: item.testId,
          icon: <item.Icon className="h-3.5 w-3.5" strokeWidth={2} />,
        }))}
      />

      {/* Workspace section */}
      {/* Session list */}
      {!sidebarCollapsed && (
        <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2 space-y-2 pt-4">
          {/* Workspaces */}
          {allWorkspaces.length > 0 && (!isSessionListQueryActive || totalWorkspaceSessionCount > 0) && (
            <div data-testid="sidebar-workspaces-section" className="pb-2">
              <div className="flex items-center justify-between gap-1 px-2.5 pb-1">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 cursor-pointer text-left"
                  onClick={toggleWorkspaceSection}
                  aria-expanded={!workspacesCollapsed}
                >
                  <span
                    className="text-[11px] font-medium text-muted-foreground/60 tracking-tight"
                    data-testid="sidebar-workspaces-section-header"
                  >
                    {t('sidebar.workspaces')}({totalWorkspaceSessionCount})
                  </span>
                </button>
                {renderBatchDeleteButton()}
                <button
                  type="button"
                  className="flex shrink-0 items-center justify-center cursor-pointer"
                  onClick={toggleWorkspaceSection}
                  aria-expanded={!workspacesCollapsed}
                >
                  <ChevronRight
                    className={cn(
                      'h-3 w-3 text-muted-foreground transition-transform',
                      !workspacesCollapsed && 'rotate-90',
                    )}
                  />
                </button>
              </div>
              {!workspacesCollapsed && (
                <div className="space-y-0.5 mt-1">
                  {allWorkspaces
                    .slice()
                    .sort((a, b) => b.createdAt - a.createdAt)
                    .filter((workspace) => !isSessionListQueryActive || Boolean(filteredSessionsByWorkspaceId[workspace.id]?.length))
                    .map((workspace) => {
                      const displayName = workspace.name;
                      const workspaceSessions = filteredSessionsByWorkspaceId[workspace.id] ?? [];
                      const sessionCount = workspaceSessions.length;
                      const chatsExpanded = sessionCount > 0 && !workspaceChatsCollapsedIds.has(workspace.id);
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
                                data-testid={`sidebar-workspace-new-session-${workspace.id}`}
                                className="flex shrink-0 items-center justify-center w-5 h-5 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                                onMouseDown={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }}
                                onClick={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  handleWorkspaceNewSession(workspace.id);
                                }}
                                title={t('sidebar.newSessionInWorkspace')}
                              >
                                <Plus className="h-3 w-3 text-muted-foreground" />
                              </button>
                              <button
                                type="button"
                                className="flex shrink-0 items-center justify-center w-5 h-5 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void invokeIpc('shell:openPath', workspace.path);
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
                                  {workspaceSessions.map((session) =>
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
          {allWorkspaces.length === 0 && batchDeleteSessionCount > 0 && (
            <div className="flex justify-end px-2.5 pb-1">
              {renderBatchDeleteButton()}
            </div>
          )}
          {isSessionListQueryActive && !hasAnySessionListMatch ? (
            <div
              data-testid="sidebar-session-search-empty"
              className="px-2.5 py-4 text-center text-[12px] text-muted-foreground/70"
            >
              {isSessionSearchActive && isSessionCategoryFilterActive
                ? t('common:sidebar.searchSessionsEmpty')
                : isSessionCategoryFilterActive
                  ? t('common:sidebar.sessionFilterEmpty')
                  : t('common:sidebar.searchSessionsEmpty')}
            </div>
          ) : null}
          {(!isSessionListQueryActive
            ? orderedSidebarSessions.some((s) => !isSessionListedUnderWorkspace(s.key))
            : filteredPinnedHistorySessions.length > 0 || filteredSessionBuckets.some((bucket) => bucket.sessions.length > 0)) && (
            <div className="space-y-0.5">
              {filteredPinnedHistorySessions.length > 0 ? (
                <div className="pt-2">
                  {renderHistorySectionHeader(
                    'pinned',
                    t('chat:historyBuckets.pinned'),
                    filteredPinnedHistorySessions.length,
                  )}
                  {isHistorySectionExpanded('pinned')
                    ? filteredPinnedHistorySessions.map((session) => renderChatSessionRow(session))
                    : null}
                </div>
              ) : null}
              {filteredSessionBuckets.map((bucket) => (
                bucket.sessions.length > 0 ? (
                  <div key={bucket.key} className="pt-2">
                    {renderHistorySectionHeader(bucket.key, bucket.label, bucket.sessions.length)}
                    {isHistorySectionExpanded(bucket.key)
                      ? bucket.sessions.map((session) => renderChatSessionRow(session))
                      : null}
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

        {/* OpenClaw 控制台入口暂时隐藏
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
        */}
      </div>
    </aside>

      <BatchDeleteSessionsDialog
        open={batchDeleteOpen}
        onOpenChange={setBatchDeleteOpen}
        groups={batchDeleteSessionGroups}
        title={t('common:sidebar.batchDeleteTitle')}
        subtitle={t('common:sidebar.batchDeleteSubtitle', { count: batchDeleteSessionCount })}
        selectAllLabel={t('common:sidebar.batchDeleteSelectAll')}
        selectAllAria={t('common:sidebar.batchDeleteSelectAll')}
        deselectAllAria={t('common:sidebar.batchDeleteDeselectAll')}
        cancelLabel={t('common:actions.cancel')}
        deleteLabel={t('common:actions.delete')}
        confirmTitle={t('common:actions.confirm')}
        confirmMessage={t('common:sidebar.batchDeleteConfirm')}
        emptySelectionMessage={t('common:sidebar.batchDeleteNoSessions')}
        onDelete={handleBatchDeleteSessions}
      />

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
                className="h-8 text-[13px] font-medium rounded-lg px-3 bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm"
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
