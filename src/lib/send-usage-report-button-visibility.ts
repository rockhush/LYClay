import { useEffect, useState } from 'react';

/** localStorage key; default absent/false keeps the button hidden. */
export const SHOW_SEND_USAGE_REPORT_STORAGE_KEY = 'lyclaw.showSendUsageReport';

export const SEND_USAGE_REPORT_VISIBILITY_EVENT = 'lyclaw:send-usage-report-visibility';

export function readShowSendUsageReportButton(): boolean {
  try {
    return localStorage.getItem(SHOW_SEND_USAGE_REPORT_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setShowSendUsageReportButton(show: boolean): void {
  try {
    localStorage.setItem(SHOW_SEND_USAGE_REPORT_STORAGE_KEY, show ? 'true' : 'false');
  } catch {
    // Ignore quota / private-mode failures; visibility stays unchanged.
  }
  window.dispatchEvent(new Event(SEND_USAGE_REPORT_VISIBILITY_EVENT));
}

let consoleHelpersRegistered = false;

/** Expose `lyclawSetSendUsageReportButton(true|false)` on window for DevTools. */
export function registerSendUsageReportConsoleHelpers(): void {
  if (consoleHelpersRegistered || typeof window === 'undefined') return;
  consoleHelpersRegistered = true;
  (
    window as Window & { lyclawSetSendUsageReportButton?: (show: boolean) => void }
  ).lyclawSetSendUsageReportButton = (show: boolean) => {
    setShowSendUsageReportButton(show);
    console.info(`[LYClaw] 发送统计 button ${show ? 'visible' : 'hidden'}`);
  };
}

export function useShowSendUsageReportButton(): boolean {
  const [visible, setVisible] = useState(readShowSendUsageReportButton);

  useEffect(() => {
    registerSendUsageReportConsoleHelpers();
    const sync = () => setVisible(readShowSendUsageReportButton());
    window.addEventListener(SEND_USAGE_REPORT_VISIBILITY_EVENT, sync);
    return () => window.removeEventListener(SEND_USAGE_REPORT_VISIBILITY_EVENT, sync);
  }, []);

  return visible;
}
