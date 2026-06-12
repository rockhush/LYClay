import { describe, expect, it } from 'vitest';
import {
  formatUpdateFriendlyError,
  isUpdateIntranetOrNetworkError,
  UPDATE_INTRANET_REQUIRED_MESSAGE,
} from '@/lib/update-errors';

describe('update-errors', () => {
  it('maps JSON parse failures to intranet message', () => {
    expect(formatUpdateFriendlyError('Unexpected token < in JSON at position 0'))
      .toBe(UPDATE_INTRANET_REQUIRED_MESSAGE);
  });

  it('maps small download failures to intranet message', () => {
    expect(formatUpdateFriendlyError('Download failed: file too small (125 bytes)'))
      .toBe(UPDATE_INTRANET_REQUIRED_MESSAGE);
  });

  it('keeps unrelated errors unchanged', () => {
    expect(formatUpdateFriendlyError('Permission denied')).toBe('Permission denied');
  });

  it('detects intranet/network patterns', () => {
    expect(isUpdateIntranetOrNetworkError('fetch failed')).toBe(true);
    expect(isUpdateIntranetOrNetworkError('Permission denied')).toBe(false);
  });
});
