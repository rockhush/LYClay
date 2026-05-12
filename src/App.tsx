/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Component, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Toaster } from 'sonner';
import { Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TitleBar } from './components/layout/TitleBar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Models } from './pages/Models';
import { Chat } from './pages/Chat';
import { Agents } from './pages/Agents';
import { Channels } from './pages/Channels';
import { Skills } from './pages/Skills';
import { Cron } from './pages/Cron';
import { Settings } from './pages/Settings';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { useProviderStore } from './stores/providers';
import { useDingTalkAuthStore } from './stores/dingtalk-auth';
import { useChatStore } from './stores/chat';
import { applyGatewayTransportPreference } from './lib/api-client';
import { rendererExtensionRegistry } from './extensions/registry';
import { loadExternalRendererExtensions } from './extensions/_ext-bridge.generated';
import { hostApiFetch, getDingTalkChannelAutoFromEnv, sendDingTalkWorkspaceWelcome } from './lib/host-api';
import { estimateGatewayWarmupProgress } from './lib/gateway-warmup-progress';
import {
  isOpenClawDingTalkChannelRuntimeReady,
  type ChannelsStatusRpcPayload,
} from './lib/dingtalk-channels-runtime';

/**
 * Error Boundary to catch and display React rendering errors
 */
class ErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean; error: Error | null }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React Error Boundary caught error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '40px',
          color: '#f87171',
          background: '#0f172a',
          minHeight: '100vh',
          fontFamily: 'monospace'
        }}>
          <h1 style={{ fontSize: '24px', marginBottom: '16px' }}>Something went wrong</h1>
          <pre style={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            background: '#1e293b',
            padding: '16px',
            borderRadius: '8px',
            fontSize: '14px'
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </pre>
          <button
            onClick={() => { this.setState({ hasError: false, error: null }); window.location.reload(); }}
            style={{
              marginTop: '16px',
              padding: '8px 16px',
              background: '#3b82f6',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer'
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function App() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const location = useLocation();
  const skipSetupForE2E = typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('e2eSkipSetup') === '1';
  const requireDingTalkLogin = !skipSetupForE2E;
  const initSettings = useSettingsStore((state) => state.init);
  const theme = useSettingsStore((state) => state.theme);
  const language = useSettingsStore((state) => state.language);
  const setupComplete = useSettingsStore((state) => state.setupComplete);
  const initGateway = useGatewayStore((state) => state.init);
  const gatewayStatus = useGatewayStore((state) => state.status);
  const gatewayInitialized = useGatewayStore((state) => state.isInitialized);
  const initProviders = useProviderStore((state) => state.init);
  const initDingTalkAuth = useDingTalkAuthStore((state) => state.init);
  const dingtalkUser = useDingTalkAuthStore((state) => state.user);
  const dingtalkAuthInitialized = useDingTalkAuthStore((state) => state.initialized);
  const [postLoginWarmupDone, setPostLoginWarmupDone] = useState(false);
  const [postLoginWarmupSeconds, setPostLoginWarmupSeconds] = useState(0);
  const postLoginBootstrapRef = useRef<string | null>(null);
  const [autoDingTalkChannelFromEnv, setAutoDingTalkChannelFromEnv] = useState<boolean | null>(null);
  const [dingTalkChannelRuntimeReady, setDingTalkChannelRuntimeReady] = useState(false);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  useEffect(() => {
    initDingTalkAuth();
  }, [initDingTalkAuth]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    initGateway();
  }, [initGateway]);

  // Initialize provider snapshot on mount
  useEffect(() => {
    initProviders();
  }, [initProviders]);

  // Redirect to setup wizard if not complete
  useEffect(() => {
    if (!setupComplete && !skipSetupForE2E && !location.pathname.startsWith('/setup')) {
      navigate('/setup');
    }
  }, [setupComplete, skipSetupForE2E, location.pathname, navigate]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (...args: unknown[]) => {
      const path = args[0];
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const unsubscribe = window.electron.ipcRenderer.on('navigate', handleNavigate);

    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [navigate]);

  // Apply theme
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    let appliedTheme = theme;
    if (theme === 'system') {
      appliedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light';
    }
    root.classList.add(appliedTheme);
  }, [theme]);

  useEffect(() => {
    applyGatewayTransportPreference();
  }, []);

  // Load external renderer extensions (generated by scripts/generate-ext-bridge.mjs)
  // and initialize all registered extensions.
  useEffect(() => {
    loadExternalRendererExtensions();
    void rendererExtensionRegistry.initializeAll();
    return () => rendererExtensionRegistry.teardownAll();
  }, []);

  useEffect(() => {
    if (!dingtalkUser) {
      setPostLoginWarmupDone(false);
      postLoginBootstrapRef.current = null;
      setAutoDingTalkChannelFromEnv(null);
      setDingTalkChannelRuntimeReady(false);
    }
  }, [dingtalkUser]);

  useEffect(() => {
    if (!requireDingTalkLogin || !dingtalkUser) return;
    let cancelled = false;
    void getDingTalkChannelAutoFromEnv()
      .then((r) => {
        if (!cancelled) setAutoDingTalkChannelFromEnv(!!r.active);
      })
      .catch(() => {
        if (!cancelled) setAutoDingTalkChannelFromEnv(false);
      });
    return () => {
      cancelled = true;
    };
  }, [requireDingTalkLogin, dingtalkUser]);

  useEffect(() => {
    if (!requireDingTalkLogin || !dingtalkUser || postLoginWarmupDone) return;
    if (autoDingTalkChannelFromEnv !== true) {
      setDingTalkChannelRuntimeReady(false);
      return;
    }
    if (gatewayStatus.state !== 'running' || !gatewayStatus.gatewayReady) return;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      try {
        const data = await useGatewayStore.getState().rpc<ChannelsStatusRpcPayload>('channels.status', {
          probe: false,
        });
        if (!cancelled && isOpenClawDingTalkChannelRuntimeReady(data)) {
          setDingTalkChannelRuntimeReady(true);
        }
      } catch {
        /* Gateway may still be restarting; retry on interval */
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [
    requireDingTalkLogin,
    dingtalkUser,
    postLoginWarmupDone,
    autoDingTalkChannelFromEnv,
    gatewayStatus.state,
    gatewayStatus.gatewayReady,
  ]);

  useEffect(() => {
    if (!requireDingTalkLogin || !dingtalkUser || postLoginWarmupDone) return;

    setPostLoginWarmupSeconds(0);
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - startedAt) / 1000);
      setPostLoginWarmupSeconds(elapsed);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [requireDingTalkLogin, dingtalkUser, postLoginWarmupDone]);

  useEffect(() => {
    if (!requireDingTalkLogin || !dingtalkUser || postLoginWarmupDone) return;

    const warmupStatus = gatewayStatus.warmupStatus;
    const gatewayUnavailable = gatewayInitialized && (gatewayStatus.state === 'error' || gatewayStatus.state === 'stopped');
    const warmupDisabledOrIdle = gatewayStatus.state === 'running'
      && gatewayStatus.gatewayReady === true
      && warmupStatus === 'idle'
      && postLoginWarmupSeconds >= 7;
    const needDingTalkRuntime = autoDingTalkChannelFromEnv === true;
    const dingTalkRuntimeOk = !needDingTalkRuntime || dingTalkChannelRuntimeReady || postLoginWarmupSeconds >= 90;
    const shouldProceed =
      (warmupStatus === 'ready'
      || warmupStatus === 'failed'
      || warmupDisabledOrIdle
      || gatewayUnavailable
      || postLoginWarmupSeconds >= 90)
      && dingTalkRuntimeOk;

    if (!shouldProceed) return;

    const dtSeg = !needDingTalkRuntime
      ? 'na'
      : dingTalkChannelRuntimeReady
        ? 'ok'
        : postLoginWarmupSeconds >= 90
          ? 'force'
          : 'wait';

    const bootstrapKey = [
      dingtalkUser.userId || dingtalkUser.unionId || dingtalkUser.name || 'user',
      gatewayStatus.state,
      gatewayStatus.gatewayReady ? 'ready' : 'not-ready',
      warmupStatus || 'unknown',
      dtSeg,
    ].join('|');
    if (postLoginBootstrapRef.current === bootstrapKey) return;
    postLoginBootstrapRef.current = bootstrapKey;

    const delay = warmupStatus === 'ready' ? 500 : 0;
    window.setTimeout(() => {
      void (async () => {
        const chat = useChatStore.getState();
        try {
          await chat.loadSessions();
          if (postLoginBootstrapRef.current === bootstrapKey && useChatStore.getState().messages.length === 0) {
            await useChatStore.getState().loadHistory();
          }
        } catch (error) {
          console.warn('[post-login-warmup] Initial chat data bootstrap failed:', error);
        } finally {
          if (postLoginBootstrapRef.current === bootstrapKey) {
            setPostLoginWarmupDone(true);
          }
        }
      })();
    }, delay);
  }, [
    requireDingTalkLogin,
    dingtalkUser,
    postLoginWarmupDone,
    gatewayInitialized,
    gatewayStatus.state,
    gatewayStatus.gatewayReady,
    gatewayStatus.warmupStatus,
    postLoginWarmupSeconds,
    autoDingTalkChannelFromEnv,
    dingTalkChannelRuntimeReady,
  ]);

  useEffect(() => {
    if (!requireDingTalkLogin) return;
    if (!dingtalkAuthInitialized) return;
    if (!dingtalkUser?.userId?.trim()) return;
    if (!postLoginWarmupDone) return;
    // BFF welcome only once per completed DingTalk OAuth (not on refresh / restored session).
    if (!useDingTalkAuthStore.getState().consumeDingTalkLoginWelcomePending()) return;

    void sendDingTalkWorkspaceWelcome().catch(() => {});
  }, [requireDingTalkLogin, dingtalkAuthInitialized, dingtalkUser, postLoginWarmupDone]);

  const extraRoutes = rendererExtensionRegistry.getExtraRoutes();

  if (requireDingTalkLogin && !dingtalkAuthInitialized) {
    return (
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <div className="flex h-screen flex-col bg-background">
            <TitleBar />
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
          </div>
        </TooltipProvider>
      </ErrorBoundary>
    );
  }

  if (requireDingTalkLogin && dingtalkAuthInitialized && !dingtalkUser) {
    return (
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <Login />
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            style={{ zIndex: 99999 }}
          />
        </TooltipProvider>
      </ErrorBoundary>
    );
  }

  if (requireDingTalkLogin && dingtalkUser && !postLoginWarmupDone) {
    return (
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <PostLoginWarmup
            progress={estimateGatewayWarmupProgress(gatewayStatus, postLoginWarmupSeconds)}
            title={t('dingtalk.authPage.warmupTitle')}
            description={t('dingtalk.authPage.warmupDesc')}
          />
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            style={{ zIndex: 99999 }}
          />
        </TooltipProvider>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <TooltipProvider delayDuration={300}>
        <Routes>
          {/* Setup wizard (shown on first launch) */}
          <Route path="/setup/*" element={<Setup />} />

          {/* Main application routes */}
          <Route element={<MainLayout />}>
            <Route path="/" element={<Chat />} />
            <Route path="/models" element={<Models />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/skills" element={<Skills />} />
            <Route path="/cron" element={<Cron />} />
            <Route path="/settings/*" element={<Settings />} />
            {extraRoutes.map((r) => (
              <Route key={r.path} path={r.path} element={<r.component />} />
            ))}
          </Route>
        </Routes>

        {/* Global toast notifications */}
        <Toaster
          position="bottom-right"
          richColors
          closeButton
          style={{ zIndex: 99999 }}
        />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function PostLoginWarmup({
  progress,
  title,
  description,
}: {
  progress: number;
  title: string;
  description: string;
}) {
  const [logoSrc, setLogoSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void hostApiFetch<{ success: boolean; dataUrl?: string }>(
      '/api/app/icon?name=512x512.png',
    )
      .then((result) => {
        if (!cancelled && result.success && result.dataUrl) {
          setLogoSrc(result.dataUrl);
        }
      })
      .catch(() => {
        // Fall back to the icon placeholder when the asset can't be loaded.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div data-testid="post-login-warmup" className="flex h-screen flex-col overflow-hidden bg-[#f7f6f0] text-[#1f1f1f] dark:bg-[#11110f] dark:text-foreground">
      <TitleBar />
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)',
            backgroundSize: '18px 18px',
          }}
        />
        <main className="relative z-10 flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
          <div className="flex w-full max-w-[460px] flex-col items-center rounded-[32px] border border-[#ded6c7]/70 bg-[#f4f1e9]/70 px-10 py-14 text-center shadow-[0_18px_50px_rgba(79,64,38,0.08)] backdrop-blur-sm dark:border-white/10 dark:bg-white/5">
            <div className="mx-auto flex h-20 w-20 items-center justify-center overflow-hidden rounded-3xl bg-[#fbfaf6] shadow-sm">
              {logoSrc ? (
                <img src={logoSrc} alt="LYClaw" className="h-full w-full object-contain" />
              ) : (
                <Sparkles className="h-9 w-9 text-muted-foreground" />
              )}
            </div>
            <h1 className="mt-8 text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-4 text-sm text-muted-foreground">{description}</p>
            <div className="mx-auto mt-9 h-2 w-48 overflow-hidden rounded-full bg-[#e8dfd0] dark:bg-white/10">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-700 ease-out"
                style={{ width: `${Math.max(12, Math.min(100, progress))}%` }}
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(progress)}
              />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default App;
