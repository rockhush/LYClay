import { describe, expect, it } from 'vitest';
import { deviceAccessInternals } from '@electron/utils/device-access';

describe('device access token helpers', () => {
  it('formats SHA bytes like .NET Guid(byte[]).ToString()', () => {
    const bytes = Buffer.from([
      0x00, 0x01, 0x02, 0x03,
      0x04, 0x05,
      0x06, 0x07,
      0x08, 0x09,
      0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
    ]);

    expect(deviceAccessInternals.formatDotNetGuidFromBytes(bytes))
      .toBe('03020100-0504-0706-0809-0a0b0c0d0e0f');
  });

  it('builds stable Windows device-id candidates from hardware fields', () => {
    expect(deviceAccessInternals.buildWindowsDeviceIdCandidates({
      macAddresses: ['AA:BB:CC:DD:EE:FF'],
      processorId: 'CPU123',
      motherboardSerialNumber: 'BOARD456',
    })).toEqual([
      'AA:BB:CC:DD:EE:FFCPU123BOARD456',
      'AA:BB:CC:DD:EE:FF|CPU123|BOARD456',
      'MacAddress=AA:BB:CC:DD:EE:FF|ProcessorId=CPU123|MotherboardSerialNumber=BOARD456',
      'MacAddress=AA:BB:CC:DD:EE:FF;ProcessorId=CPU123;MotherboardSerialNumber=BOARD456',
    ]);
  });
});
