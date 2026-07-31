import { afterEach, describe, expect, it } from 'vitest';
import {
  readShowSendUsageReportButton,
  setShowSendUsageReportButton,
  SHOW_SEND_USAGE_REPORT_STORAGE_KEY,
} from '../../src/lib/send-usage-report-button-visibility';

describe('send-usage-report-button-visibility', () => {
  afterEach(() => {
    localStorage.removeItem(SHOW_SEND_USAGE_REPORT_STORAGE_KEY);
  });

  it('defaults to hidden when storage is unset', () => {
    expect(readShowSendUsageReportButton()).toBe(false);
  });

  it('reads true only when storage is explicitly true', () => {
    localStorage.setItem(SHOW_SEND_USAGE_REPORT_STORAGE_KEY, 'true');
    expect(readShowSendUsageReportButton()).toBe(true);
    localStorage.setItem(SHOW_SEND_USAGE_REPORT_STORAGE_KEY, 'false');
    expect(readShowSendUsageReportButton()).toBe(false);
  });

  it('persists visibility toggles via setShowSendUsageReportButton', () => {
    setShowSendUsageReportButton(true);
    expect(readShowSendUsageReportButton()).toBe(true);
    setShowSendUsageReportButton(false);
    expect(readShowSendUsageReportButton()).toBe(false);
  });
});
