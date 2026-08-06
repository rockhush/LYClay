import { Check, Download, Loader2, RefreshCw, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { NewSkillInfo, UpdatableSkillInfo } from '@/lib/skill-update-check';
import { runSilentSkillNotificationAction } from '@/lib/startup-skill-notification-actions';
import { refreshStartupSkillNotificationState } from '@/lib/startup-skill-notification-state';

type StartupSkillNotificationToastProps = {
  toastId: string | number;
  title: string;
  updatable: UpdatableSkillInfo[];
  newSkills: NewSkillInfo[];
  updatePrefix: string;
  newPrefix: string;
};

export type StartupNotificationItem = {
  key: string;
  slug: string;
  name: string;
  variant: 'update' | 'new';
  prefix: string;
};

type ActionStatus = 'idle' | 'loading' | 'success' | 'failed';

function buildNotificationItems(
  updatable: UpdatableSkillInfo[],
  newSkills: NewSkillInfo[],
  updatePrefix: string,
  newPrefix: string,
): StartupNotificationItem[] {
  return [
    ...updatable.map((item) => ({
      key: `update-${item.slug}`,
      slug: item.slug,
      name: item.name,
      variant: 'update' as const,
      prefix: updatePrefix,
    })),
    ...newSkills.map((item) => ({
      key: `new-${item.slug}`,
      slug: item.slug,
      name: item.name,
      variant: 'new' as const,
      prefix: newPrefix,
    })),
  ];
}

function NotificationActionButton({
  status,
  onAction,
  installLabel,
  retryLabel,
  successLabel,
}: {
  status: ActionStatus;
  onAction: () => void;
  installLabel: string;
  retryLabel: string;
  successLabel: string;
}) {
  if (status === 'success') {
    return (
      <span
        className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-[#22C55E]"
        title={successLabel}
        aria-label={successLabel}
      >
        <Check className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    );
  }

  if (status === 'loading') {
    return (
      <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      </span>
    );
  }

  const isRetry = status === 'failed';
  const label = isRetry ? retryLabel : installLabel;

  return (
    <button
      type="button"
      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#FF922B] transition-colors hover:bg-[#FFF2E5] dark:hover:bg-white/10"
      title={label}
      aria-label={label}
      onClick={onAction}
    >
      {isRetry ? (
        <RefreshCw className="h-3.5 w-3.5" />
      ) : (
        <Download className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

function NotificationLine({
  item,
  status,
  onAction,
  installLabel,
  retryLabel,
  successLabel,
}: {
  item: StartupNotificationItem;
  status: ActionStatus;
  onAction: () => void;
  installLabel: string;
  retryLabel: string;
  successLabel: string;
}) {
  const dotClass = item.variant === 'update'
    ? 'bg-[#FF922B]'
    : 'bg-muted-foreground/35 dark:bg-muted-foreground/50';

  return (
    <div className="flex items-center gap-2 py-1">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span
        className="min-w-0 flex-1 truncate text-[12px] leading-[18px] text-foreground/90"
        title={`${item.prefix}${item.name}`}
      >
        {item.prefix}
        {item.name}
      </span>
      <NotificationActionButton
        status={status}
        onAction={onAction}
        installLabel={installLabel}
        retryLabel={retryLabel}
        successLabel={successLabel}
      />
    </div>
  );
}

export function StartupSkillNotificationToast({
  toastId,
  title,
  updatable,
  newSkills,
  updatePrefix,
  newPrefix,
}: StartupSkillNotificationToastProps) {
  const { t } = useTranslation('skills');
  const items = useMemo(
    () => buildNotificationItems(updatable, newSkills, updatePrefix, newPrefix),
    [updatable, newSkills, updatePrefix, newPrefix],
  );
  const [actionStates, setActionStates] = useState<Record<string, ActionStatus>>({});

  const handleAction = useCallback(async (item: StartupNotificationItem) => {
    let shouldRun = false;
    setActionStates((prev) => {
      const current = prev[item.key] ?? 'idle';
      if (current === 'loading' || current === 'success') return prev;
      shouldRun = true;
      return { ...prev, [item.key]: 'loading' };
    });
    if (!shouldRun) return;

    const result = await runSilentSkillNotificationAction(item.variant, item.slug);
    setActionStates((prev) => ({
      ...prev,
      [item.key]: result === 'success' ? 'success' : 'failed',
    }));
    if (result === 'success') {
      void refreshStartupSkillNotificationState();
    }
  }, []);

  const installLabel = t('toast.notificationInstall', { defaultValue: '安装' });
  const retryLabel = t('toast.notificationRetry', { defaultValue: '重新安装' });
  const successLabel = t('toast.notificationInstalled', { defaultValue: '安装成功' });

  return (
    <div className="w-[320px] rounded-xl border border-black/[0.08] bg-white p-3 shadow-[0_8px_24px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[hsl(var(--card))]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <button
          type="button"
          aria-label="Close"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/10"
          onClick={() => toast.dismiss(toastId)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="startup-skill-toast-scroll max-h-[120px] overflow-y-auto overflow-x-hidden">
        {items.map((item) => (
          <NotificationLine
            key={item.key}
            item={item}
            status={actionStates[item.key] ?? 'idle'}
            onAction={() => { void handleAction(item); }}
            installLabel={installLabel}
            retryLabel={retryLabel}
            successLabel={successLabel}
          />
        ))}
      </div>
    </div>
  );
}
