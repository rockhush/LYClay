import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TitleBar } from '@/components/layout/TitleBar';
import { hostApiFetch, type DingTalkUserInfo } from '@/lib/host-api';
import { toUserMessage } from '@/lib/api-client';
import { useDingTalkAuthStore } from '@/stores/dingtalk-auth';

type StartLoginResponse = {
  success: boolean;
  loginId?: string;
  authorizeUrl?: string;
  user?: DingTalkUserInfo | null;
  alreadyLoggedIn?: boolean;
  error?: string;
};

type LoginStatusResponse = {
  success: boolean;
  status: 'pending' | 'success' | 'error' | 'expired';
  statusMessage?: string;
  user?: DingTalkUserInfo | null;
  error?: string;
};

export function Login() {
  const { t } = useTranslation('settings');
  const navigate = useNavigate();
  const setUser = useDingTalkAuthStore((state) => state.setUser);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const startedRef = useRef(false);

  const startLogin = useCallback(async () => {
    setLoading(true);
    setError('');
    setStatusMessage(t('dingtalk.authPage.starting'));
    try {
      const result = await hostApiFetch<StartLoginResponse>('/api/dingtalk/login/start', {
        method: 'POST',
        body: JSON.stringify({ force: true }),
      });

      if (result.success && result.user) {
        setUser(result.user, true);
        navigate('/', { replace: true });
        return;
      }

      if (!result.success || !result.loginId || !result.authorizeUrl) {
        throw new Error(result.error || t('dingtalk.loginFailed'));
      }

      setLoginId(result.loginId);
      setAuthorizeUrl(result.authorizeUrl);
      setStatusMessage(t('dingtalk.authPage.waiting'));
    } catch (caught) {
      setError(toUserMessage(caught));
      setStatusMessage('');
    } finally {
      setLoading(false);
    }
  }, [navigate, setUser, t]);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    void startLogin();
  }, [startLogin]);

  useEffect(() => {
    if (!loginId) return;

    const interval = window.setInterval(async () => {
      try {
        const result = await hostApiFetch<LoginStatusResponse>(
          `/api/dingtalk/login/status?loginId=${encodeURIComponent(loginId)}`,
        );
        if (result.statusMessage) {
          setStatusMessage(result.statusMessage);
        }
        if (result.success && result.status === 'success' && result.user) {
          window.clearInterval(interval);
          setUser(result.user, true);
          navigate('/', { replace: true });
        } else if (result.status === 'error' || result.status === 'expired') {
          window.clearInterval(interval);
          setError(result.error || t('dingtalk.loginFailed'));
          setStatusMessage('');
        }
      } catch (caught) {
        window.clearInterval(interval);
        setError(toUserMessage(caught));
        setStatusMessage('');
      }
    }, 1500);

    return () => window.clearInterval(interval);
  }, [loginId, navigate, setUser, t]);

  return (
    <div data-testid="login-page" className="flex h-screen flex-col overflow-hidden bg-[#f7f6f0] text-[#1f1f1f] dark:bg-[#11110f] dark:text-foreground">
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
          <div className="w-full max-w-[420px] text-center">
            <h2 className="text-2xl font-semibold">{t('dingtalk.authPage.title')}</h2>
            <p className="mt-14 text-sm text-muted-foreground">{t('dingtalk.authPage.scanTip')}</p>
            <div className="mt-4 overflow-hidden rounded-[28px] border border-[#ded6c7]/70 bg-[#f4f1e9]/70 p-3 shadow-[0_18px_50px_rgba(79,64,38,0.08)] backdrop-blur-sm dark:border-white/10 dark:bg-white/5">
              {authorizeUrl ? (
                <div className="h-[440px] w-full overflow-hidden rounded-[22px] bg-[#fbfaf6] shadow-inner">
                  <iframe
                    data-testid="dingtalk-login-frame"
                    title={t('dingtalk.title')}
                    src={authorizeUrl}
                    className="h-[550px] w-[125%] origin-top-left scale-[0.8] border-0 bg-[#fbfaf6]"
                    scrolling="no"
                    sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-top-navigation-by-user-activation"
                  />
                </div>
              ) : (
                <div className="flex h-[440px] items-center justify-center rounded-[22px] bg-[#fbfaf6]">
                  <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            <div className="mt-5 min-h-6 text-sm text-muted-foreground">
              {statusMessage || error}
            </div>

            <Button
              type="button"
              variant="outline"
              onClick={startLogin}
              disabled={loading}
              className="mt-4 rounded-full px-6"
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {t('dingtalk.authPage.retry')}
            </Button>

            <div className="mt-20 flex items-center justify-center gap-2 text-xs text-muted-foreground">
              <ShieldCheck className="h-4 w-4" />
              <span>{t('dingtalk.authPage.agreement')}</span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}

export default Login;
