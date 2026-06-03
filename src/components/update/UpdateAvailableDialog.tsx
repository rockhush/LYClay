/**
 * Global "new version available" dialog shown after startup update check.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowUpFromLine,
  Loader2,
  RefreshCw,
  Wrench,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useUpdateStore } from '@/stores/update';
import {
  parseReleaseNotes,
  type ReleaseNoteSectionKey,
} from '@/lib/update-release-notes';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function sectionIcon(key: ReleaseNoteSectionKey) {
  if (key === 'optimizations') {
    return <Wrench className="h-4 w-4 text-[#FF922B]" />;
  }
  return <RefreshCw className="h-4 w-4 text-[#FF922B]" />;
}

function sectionTitle(
  key: ReleaseNoteSectionKey,
  customTitle: string,
  t: (key: string) => string,
): string {
  if (customTitle) return customTitle;
  if (key === 'features') return t('updates.dialog.sectionFeatures');
  if (key === 'optimizations') return t('updates.dialog.sectionOptimizations');
  return t('updates.whatsNew');
}

export function UpdateAvailableDialog() {
  const { t } = useTranslation('settings');
  const {
    status,
    updateInfo,
    progress,
    error,
    autoInstallCountdown,
    isInitialized,
    init,
    downloadUpdate,
    cancelAutoInstall,
    cancelDownload,
  } = useUpdateStore();

  const [open, setOpen] = useState(false);
  /** Dismissed for the current app session only — resets on next launch. */
  const [sessionDismissed, setSessionDismissed] = useState(false);

  useEffect(() => {
    void init();
  }, [init]);

  const version = updateInfo?.version;

  // Open when update is available; keep open while downloading/installing/errors.
  useEffect(() => {
    if (!isInitialized || sessionDismissed) return;
    if (status === 'available' && version) {
      void cancelAutoInstall();
      setOpen(true);
      return;
    }
    if (status === 'downloading' || status === 'downloaded' || status === 'error') {
      setOpen(true);
    }
  }, [isInitialized, status, version, sessionDismissed, cancelAutoInstall]);

  const sections = useMemo(
    () => parseReleaseNotes(updateInfo?.releaseNotes ?? ''),
    [updateInfo?.releaseNotes],
  );

  const isWindows = window.electron?.platform === 'win32';
  const isInstallCountdownActive = autoInstallCountdown != null && autoInstallCountdown > 0;
  const isDownloading = status === 'downloading';
  // Only show install countdown after a successful download — stale countdown ticks
  // must not override the downloading/error panels during retry.
  const isInstalling = status === 'downloaded';
  const isDownloadError = status === 'error' && open;
  const showProgressPanel = isDownloading || isInstalling || isDownloadError;
  const isBusy = isDownloading || isInstalling;

  const handleRemindLater = useCallback(async () => {
    if (status === 'downloading') {
      await cancelDownload();
    } else {
      await cancelAutoInstall();
    }
    setSessionDismissed(true);
    setOpen(false);
  }, [status, cancelDownload, cancelAutoInstall]);

  const handleRetryDownload = useCallback(async () => {
    if (isBusy) return;
    await cancelAutoInstall();
    setOpen(true);
    await downloadUpdate();
  }, [cancelAutoInstall, downloadUpdate, isBusy]);

  const handleExperienceNow = useCallback(async () => {
    await handleRetryDownload();
  }, [handleRetryDownload]);

  if (!open) return null;

  return (
    <ModalOverlay
      data-testid="update-available-dialog"
      zIndexClass="z-[100]"
      className="bg-black/45 backdrop-blur-[2px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-available-dialog-title"
        className={cn(
          'relative mx-4 flex w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-[#FFD79A]/50 bg-white shadow-2xl',
          'dark:border-white/10 dark:bg-[#1c1c1c]',
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-3 border-b border-[#FFD79A]/40 px-5 py-4 dark:border-white/10">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#FFF2E5] dark:bg-[#FF922B]/15">
            <ArrowUpFromLine className="h-5 w-5 text-[#FF922B]" />
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h2
              id="update-available-dialog-title"
              className="truncate text-[16px] font-semibold text-foreground"
            >
              {t('updates.dialog.title')}
            </h2>
            {version ? (
              <span
                data-testid="update-available-dialog-version"
                className="shrink-0 rounded-md bg-[#FFF2E5] px-2 py-0.5 text-[13px] font-semibold text-[#FF922B] dark:bg-[#FF922B]/15"
              >
                v{version}
              </span>
            ) : null}
          </div>
        </div>

        {/* Body */}
        <div
          className={cn(
            'min-h-[200px] shrink-0',
            showProgressPanel ? 'px-5 py-6' : 'max-h-[min(52vh,420px)] overflow-y-auto px-5 py-4',
          )}
        >
          {isDownloadError ? (
            <div
              data-testid="update-available-dialog-progress"
              className="flex flex-col items-center justify-center py-4 text-center"
            >
              <p className="text-[14px] font-medium text-destructive">{t('updates.status.failed')}</p>
              <p className="mt-2 max-w-full text-[12px] text-muted-foreground">{error}</p>
              <Button
                type="button"
                variant="outline"
                className="mt-5 h-8 rounded-lg"
                onClick={() => void handleRetryDownload()}
              >
                {t('updates.action.retry')}
              </Button>
            </div>
          ) : isInstalling ? (
            <div
              data-testid="update-available-dialog-progress"
              className="flex flex-col items-center justify-center gap-4 py-6 text-center"
            >
              <Loader2 className="h-9 w-9 animate-spin text-[#FF922B]" />
              <p className="text-[14px] font-medium text-foreground">
                {autoInstallCountdown != null && autoInstallCountdown >= 0
                  ? t('updates.status.autoInstalling', { seconds: autoInstallCountdown })
                  : t('updates.status.downloaded')}
              </p>
              <p className="max-w-[360px] text-[12px] leading-relaxed text-muted-foreground">
                {isWindows ? t('updates.antivirusHint') : t('updates.status.downloaded')}
              </p>
            </div>
          ) : isDownloading ? (
            <div data-testid="update-available-dialog-progress" className="space-y-4">
              <p className="text-[14px] font-medium text-foreground">
                {t('updates.status.downloading')}
              </p>
              {progress ? (
                <div className="space-y-2">
                  <div className="flex justify-between text-sm">
                    <span>
                      {formatBytes(progress.transferred)} / {formatBytes(progress.total)}
                    </span>
                  </div>
                  <Progress value={progress.percent} className="h-2" />
                  <p className="text-xs text-muted-foreground text-center">
                    {Math.round(progress.percent)}% complete
                  </p>
                </div>
              ) : (
                <div className="flex items-center justify-center py-6">
                  <Loader2 className="h-6 w-6 animate-spin text-[#FF922B]" />
                </div>
              )}
            </div>
          ) : sections.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">
              {updateInfo?.releaseNotes?.trim() || t('updates.dialog.noReleaseNotes')}
            </p>
          ) : (
            <div className="space-y-5">
              {sections.map((section, sectionIndex) => (
                <section key={`${section.key}-${sectionIndex}`}>
                  <div className="mb-2.5 flex items-center gap-2">
                    {sectionIcon(section.key)}
                    <h3 className="text-[14px] font-semibold text-foreground">
                      {sectionTitle(section.key, section.title, t)}
                    </h3>
                  </div>
                  <ul className="space-y-2.5 pl-1">
                    {section.items.map((item, itemIndex) => (
                      <li
                        key={`${sectionIndex}-${itemIndex}`}
                        className="flex gap-2 text-[13px] leading-relaxed text-foreground/85"
                      >
                        <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#FF922B]" />
                        <span>
                          <span className="font-medium text-foreground">{item.headline}</span>
                          {item.detail ? (
                            <span className="text-foreground/75">：{item.detail}</span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 items-center justify-end gap-3 border-t border-[#FFD79A]/40 px-5 py-4 dark:border-white/10">
          <Button
            type="button"
            variant="outline"
            disabled={isInstalling}
            onClick={() => void handleRemindLater()}
            className="h-9 min-w-[96px] rounded-lg border-black/10 bg-white px-4 text-[13px] font-medium text-foreground/80 hover:bg-black/5 dark:border-white/10 dark:bg-transparent dark:hover:bg-white/5"
          >
            {t('updates.dialog.remindLater')}
          </Button>
          <Button
            type="button"
            disabled={isBusy}
            onClick={() => void handleExperienceNow()}
            className="h-9 min-w-[108px] rounded-lg bg-[#FF922B] px-4 text-[13px] font-medium text-white shadow-sm shadow-[#FF922B]/25 hover:bg-[#FF6A00]"
          >
            {t('updates.dialog.experienceNow')}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
