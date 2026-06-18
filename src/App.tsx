/**
 * Root Application Component
 * Handles routing and global providers
 */
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import { Component, useCallback, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Toaster } from 'sonner';
import { RefreshCw, ShieldAlert, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import i18n from './i18n';
import { MainLayout } from './components/layout/MainLayout';
import { TitleBar } from './components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { TooltipProvider } from '@/components/ui/tooltip';
import { SecurityConfirmationDialog } from '@/components/security/SecurityConfirmationDialog';
import { Models } from './pages/Models';
import { Chat } from './pages/Chat';
import { Agents } from './pages/Agents';
import { Channels } from './pages/Channels';
import { Skills } from './pages/Skills';
import { Cron } from './pages/Cron';
import { DigitalEmployee } from './pages/DigitalEmployee';
import { AiTools } from './pages/AiTools';
import { Connectors } from './pages/Connectors';
import { Settings } from './pages/Settings';
import { McpSettings } from './pages/Settings/McpSettings';
import { McpConfigEditor } from './pages/Settings/McpConfigEditor';
import { SecuritySettings } from './pages/Settings/SecuritySettings';
import { Setup } from './pages/Setup';
import { Login } from './pages/Login';
import { useSettingsStore } from './stores/settings';
import { useGatewayStore } from './stores/gateway';
import { ParticleNetwork } from '@/components/common/ParticleNetwork';
import { useProviderStore } from './stores/providers';
import { useDingTalkAuthStore } from './stores/dingtalk-auth';
import { useChatStore } from './stores/chat';
import { applyGatewayTransportPreference } from './lib/api-client';
import { subscribeHostEvent } from './lib/host-events';
import { rendererExtensionRegistry } from './extensions/registry';
import { loadExternalRendererExtensions } from './extensions/_ext-bridge.generated';
import {
  checkDeviceAccess,
  hostApiFetch,
  sendDingTalkWorkspaceWelcome,
  type DeviceAccessResult,
} from './lib/host-api';
import { flushUsageReports } from './lib/usage-reporter';
import { estimateGatewayWarmupProgress } from './lib/gateway-warmup-progress';
import { hydrateUiStateFromDisk } from './lib/ui-state-persistence';

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
  const initProviders = useProviderStore((state) => state.init);
  const initDingTalkAuth = useDingTalkAuthStore((state) => state.init);
  const dingtalkUser = useDingTalkAuthStore((state) => state.user);
  const dingtalkAuthInitialized = useDingTalkAuthStore((state) => state.initialized);
  const [postLoginWarmupDone, setPostLoginWarmupDone] = useState(false);
  const [postLoginWarmupSeconds, setPostLoginWarmupSeconds] = useState(0);
  const postLoginBootstrapRef = useRef<string | null>(null);
  const [deviceAccess, setDeviceAccess] = useState<DeviceAccessResult | null>(null);
  const [deviceAccessLoading, setDeviceAccessLoading] = useState(true);

  useEffect(() => {
    initSettings();
  }, [initSettings]);

  useEffect(() => {
    void hydrateUiStateFromDisk();
  }, []);

  const runDeviceAccessCheck = useCallback(async (force = false) => {
    setDeviceAccessLoading(true);
    try {
      // setDeviceAccess(await checkDeviceAccess(force));
      setDeviceAccess({
        success: true,
        status: 'allowed',
        allowed: true,
      });
    } catch (error) {
      setDeviceAccess({
        success: false,
        status: 'error',
        allowed: false,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setDeviceAccessLoading(false);
    }
  }, []);

  useEffect(() => {
    void runDeviceAccessCheck(false);
  }, [runDeviceAccessCheck]);

  useEffect(() => {
    if (!deviceAccess?.allowed) return;
    initDingTalkAuth();
  }, [deviceAccess?.allowed, initDingTalkAuth]);

  // Sync i18n language with persisted settings on mount
  useEffect(() => {
    if (language && language !== i18n.language) {
      i18n.changeLanguage(language);
    }
  }, [language]);

  // Initialize Gateway connection on mount
  useEffect(() => {
    if (!deviceAccess?.allowed) return;
    initGateway();
  }, [deviceAccess?.allowed, initGateway]);

  // Initialize provider snapshot on mount
  useEffect(() => {
    if (!deviceAccess?.allowed) return;
    initProviders();
  }, [deviceAccess?.allowed, initProviders]);

  // Redirect to setup wizard if not complete
  useEffect(() => {
    if (!deviceAccess?.allowed) return;
    if (!setupComplete && !skipSetupForE2E && !location.pathname.startsWith('/setup')) {
      navigate('/setup');
    }
  }, [deviceAccess?.allowed, setupComplete, skipSetupForE2E, location.pathname, navigate]);

  // Listen for navigation events from main process
  useEffect(() => {
    const handleNavigate = (path: unknown) => {
      if (typeof path === 'string') {
        navigate(path);
      }
    };

    const unsubscribe = subscribeHostEvent('app:navigate', handleNavigate);

    return unsubscribe;
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
    if (!deviceAccess?.allowed) return;
    loadExternalRendererExtensions();
    void rendererExtensionRegistry.initializeAll();
    return () => rendererExtensionRegistry.teardownAll();
  }, [deviceAccess?.allowed]);

  useEffect(() => {
    if (!dingtalkUser) {
      setPostLoginWarmupDone(false);
      postLoginBootstrapRef.current = null;
    }
  }, [dingtalkUser]);

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

    const gatewayReady = gatewayStatus.state === 'running' && gatewayStatus.gatewayReady === true;

    if (!gatewayReady) return;

    const bootstrapKey = [
      dingtalkUser.userId || dingtalkUser.unionId || dingtalkUser.name || 'user',
      gatewayStatus.state,
      gatewayStatus.gatewayReady ? 'ready' : 'not-ready',
    ].join('|');
    if (postLoginBootstrapRef.current === bootstrapKey) return;
    postLoginBootstrapRef.current = bootstrapKey;

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
    }, 0);
  }, [
    requireDingTalkLogin,
    dingtalkUser,
    postLoginWarmupDone,
    gatewayStatus.state,
    gatewayStatus.gatewayReady,
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

  // Flush queued management/claw/report records once the gateway is up AND
  // the DingTalk session is restored/refreshed. This guarantees workNo is
  // available before the upload, and hits all three endpoints unconditionally
  // so each launch leaves a verifiable trail in the backend access log.
  // Guarded by a ref so we never fire twice within the same renderer mount.
  const startupFlushFiredRef = useRef(false);
  useEffect(() => {
    if (startupFlushFiredRef.current) return;
    // Gateway must be alive — empty workNo is fine, but a missing gateway
    // means the host-api server in main may not be reachable yet.
    if (gatewayStatus.state !== 'running' || !gatewayStatus.gatewayReady) return;
    // DingTalk login is mandatory for this build (E2E-skip aside).
    if (requireDingTalkLogin) {
      if (!dingtalkAuthInitialized) return;
      if (!dingtalkUser?.userId?.trim()) return;
    }
    startupFlushFiredRef.current = true;
    void flushUsageReports('startup-after-login').catch(() => {});
  }, [
    requireDingTalkLogin,
    dingtalkAuthInitialized,
    dingtalkUser,
    gatewayStatus.state,
    gatewayStatus.gatewayReady,
  ]);

  const extraRoutes = rendererExtensionRegistry.getExtraRoutes();
  const shouldShowPostLoginWarmup = requireDingTalkLogin
    && dingtalkUser
    && !postLoginWarmupDone
    && gatewayStatus.warmupStatus !== 'failed';

  if (deviceAccessLoading || !deviceAccess) {
    return (
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <DeviceAccessGate loading onRetry={() => void runDeviceAccessCheck(true)} />
        </TooltipProvider>
      </ErrorBoundary>
    );
  }

  if (!deviceAccess.allowed) {
    return (
      <ErrorBoundary>
        <TooltipProvider delayDuration={300}>
          <DeviceAccessGate
            result={deviceAccess}
            loading={deviceAccessLoading}
            onRetry={() => void runDeviceAccessCheck(true)}
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

  if (shouldShowPostLoginWarmup) {
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
            <Route path="/ai-tools" element={<AiTools />} />
            <Route path="/connectors" element={<Connectors />} />
            <Route path="/cron" element={<Cron />} />
            <Route path="/cron/digital-employee" element={<DigitalEmployee />} />
            <Route path="/settings/mcp/config" element={<McpConfigEditor />} />
            <Route path="/settings/mcp" element={<McpSettings />} />
            <Route path="/settings/security" element={<SecuritySettings />} />
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
        <SecurityConfirmationDialog />
      </TooltipProvider>
    </ErrorBoundary>
  );
}

function DeviceAccessGate({
  result,
  loading,
  onRetry,
}: {
  result?: DeviceAccessResult | null;
  loading: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation('settings');
  const blocked = result?.status === 'blocked';
  const title = loading
    ? t('deviceAccess.checkingTitle', { defaultValue: '正在校验设备权限' })
    : blocked
      ? t('deviceAccess.blockedTitle', { defaultValue: '仅限公司电脑使用' })
      : t('deviceAccess.errorTitle', { defaultValue: '无法验证当前设备' });
  const description = loading
    ? t('deviceAccess.checkingDesc', { defaultValue: 'LYClaw 正在确认这台电脑是否已获得授权。' })
    : blocked
      ? t('deviceAccess.blockedDesc', { defaultValue: '该应用只能在公司管理的电脑上使用。' })
      : t('deviceAccess.errorDesc', { defaultValue: '请检查网络连接，或联系 IT 后重试。' });
  const rawDetail = result?.reason || result?.error || result?.deviceId;
  const detail = formatDeviceAccessDetail(rawDetail);

  return (
    <div data-testid="device-access-gate" className="flex h-screen flex-col overflow-hidden bg-[#f7f6f0] text-[#1f1f1f] dark:bg-[#11110f] dark:text-foreground">
      <TitleBar />
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
        <div className="w-full max-w-[420px] text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-[#fbfaf6] shadow-sm dark:bg-white/10">
            {loading ? (
              <RefreshCw className="h-7 w-7 animate-spin text-muted-foreground" />
            ) : (
              <ShieldAlert className="h-7 w-7 text-amber-600" />
            )}
          </div>
          <h1 className="mt-7 text-2xl font-semibold">{title}</h1>
          <p className="mt-4 text-sm leading-6 text-muted-foreground">{description}</p>
          {detail ? (
            <p className="mx-auto mt-5 max-w-[360px] break-words rounded-md bg-black/5 px-3 py-2 text-xs text-muted-foreground dark:bg-white/10">
              {detail}
            </p>
          ) : null}
          {!loading ? (
            <Button
              type="button"
              variant="outline"
              onClick={onRetry}
              className="mt-6 rounded-full px-6"
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {t('deviceAccess.retry', { defaultValue: '重新检测' })}
            </Button>
          ) : null}
        </div>
      </main>
    </div>
  );
}

function formatDeviceAccessDetail(detail?: string): string | undefined {
  const normalized = detail?.trim();
  if (!normalized) return undefined;

  const lower = normalized.toLowerCase();
  if (lower === 'unauthorized' || lower.includes('401 unauthorized')) {
    return '设备校验服务授权失败，请联系 IT 检查授权配置';
  }
  if (lower === 'forbidden' || lower.includes('403 forbidden')) {
    return '当前设备没有访问权限，请联系 IT 确认授权状态';
  }

  return normalized;
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
      '/api/app/icon?name=1.png',
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
        <ParticleNetwork />
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
