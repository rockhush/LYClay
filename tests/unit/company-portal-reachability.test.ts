import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../electron/utils/reporting/config', () => ({
  getReportingBaseUrl: () => 'http://portal.srv.lstech.com',
}));

describe('company-portal-reachability', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('returns true when portal responds', async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 200 } as Response);
    const { isCompanyPortalReachable } = await import('../../electron/utils/company-portal-reachability');
    await expect(isCompanyPortalReachable()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://portal.srv.lstech.com', expect.objectContaining({ method: 'GET' }));
  });

  it('returns false when portal request fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('network error'));
    const { isCompanyPortalReachable } = await import('../../electron/utils/company-portal-reachability');
    await expect(isCompanyPortalReachable()).resolves.toBe(false);
  });
});
