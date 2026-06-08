import { describe, expect, it } from 'vitest';
import { deviceAccessInternals } from '@electron/utils/device-access';

describe('device access helper exe integration', () => {
  it('extracts the GUID token printed by GetDeviceGUID.exe', () => {
    expect(deviceAccessInternals.parseDeviceGuidOutput([
      'banner',
      '72662979-ebf8-78a1-549e-a07a95df1d73',
      '',
    ].join('\n'))).toBe('72662979-ebf8-78a1-549e-a07a95df1d73');
  });

  it('normalizes uppercase helper output', () => {
    expect(deviceAccessInternals.parseDeviceGuidOutput('72662979-EBF8-78A1-549E-A07A95DF1D73'))
      .toBe('72662979-ebf8-78a1-549e-a07a95df1d73');
  });

  it('extracts the macOS serial number printed by ioreg', () => {
    expect(deviceAccessInternals.parseMacSerialNumberOutput([
      '+-o IOPlatformExpertDevice',
      '    "IOPlatformSerialNumber" = "C02XG2LFJGH5"',
    ].join('\n'))).toBe('C02XG2LFJGH5');
  });

  it('extracts the macOS serial number printed by system_profiler', () => {
    expect(deviceAccessInternals.parseMacSerialNumberOutput('Serial Number (system): C02XG2LFJGH5'))
      .toBe('C02XG2LFJGH5');
  });

  it('adds the Bearer scheme when the configured auth token omits it', () => {
    expect(deviceAccessInternals.formatAuthorizationHeader('test-api-token')).toBe('Bearer test-api-token');
    expect(deviceAccessInternals.formatAuthorizationHeader('Bearer test-api-token')).toBe('Bearer test-api-token');
  });

  it('maps authorization failures to a user-friendly device access message', () => {
    expect(deviceAccessInternals.formatDeviceAccessHttpError(401, { message: 'Unauthorized' }))
      .toBe('设备校验服务授权失败，请联系 IT 检查授权配置');
  });
});
