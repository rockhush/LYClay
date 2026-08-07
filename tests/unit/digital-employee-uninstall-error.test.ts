import { describe, expect, it } from 'vitest';
import { resolveDigitalEmployeeUninstallError } from '@/pages/DigitalEmployee/uninstall-error';

describe('resolveDigitalEmployeeUninstallError', () => {
  it('maps a Windows EBUSY directory failure to actionable guidance', () => {
    const raw = new Error(
      "EBUSY: resource busy or locked, rmdir 'C:\\Users\\demo\\.openclaw\\skill\\cadre-management-query-1'",
    );

    const message = resolveDigitalEmployeeUninstallError(raw);

    expect(message).toContain('文件正在被占用');
    expect(message).toContain('停止相关任务');
    expect(message).toContain('稍后重试');
    expect(message).not.toContain('C:\\Users\\demo');
  });

  it('keeps unknown uninstall failures concise and retryable', () => {
    expect(resolveDigitalEmployeeUninstallError(new Error('unexpected backend failure')))
      .toBe('卸载失败，请稍后重试。');
  });
});
