import { describe, expect, it } from 'vitest';
import { resolveDigitalEmployeeInstallError } from '@/pages/DigitalEmployee/install-error';

describe('resolveDigitalEmployeeInstallError', () => {
  it('maps excessive package entries to repackaging guidance', () => {
    const message = resolveDigitalEmployeeInstallError(
      new Error('Digital employee package contains too many entries (12102)'),
    );

    expect(message).toContain('文件数量过多');
    expect(message).toContain('重新打包');
    expect(message).not.toContain('12102');
  });
});
