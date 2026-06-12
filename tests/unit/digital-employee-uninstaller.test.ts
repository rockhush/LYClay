import { beforeEach, describe, expect, it, vi } from 'vitest';

const readInstallRecordMock = vi.fn();
const deleteAgentMock = vi.fn();
const removeInstallDirectoryMock = vi.fn();
const listInstalledMock = vi.fn();
const withDigitalEmployeeInstallLockMock = vi.fn(async (fn: () => Promise<unknown>) => fn());

vi.mock('@electron/utils/digital-employee-storage', () => ({
  getDigitalEmployeeInstallPath: (instanceId: string) => `/employees/${instanceId}`,
  listLocalDigitalEmployees: (...args: unknown[]) => listInstalledMock(...args),
  readInstallRecord: (...args: unknown[]) => readInstallRecordMock(...args),
  removeDigitalEmployeeDirectory: (...args: unknown[]) => removeInstallDirectoryMock(...args),
}));

vi.mock('@electron/services/digital-employee-installer', () => ({
  withDigitalEmployeeInstallLock: (...args: unknown[]) => withDigitalEmployeeInstallLockMock(...args),
}));

describe('digital-employee-uninstaller', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    readInstallRecordMock.mockResolvedValue({
      instanceId: 'pkg--1234',
      marketEmployeeId: '7',
      agentId: 'employee-pkg-1234',
      installPath: '/employees/pkg--1234',
    });
    deleteAgentMock.mockResolvedValue(undefined);
    removeInstallDirectoryMock.mockResolvedValue(undefined);
    listInstalledMock.mockResolvedValue([
      { instanceId: 'pkg--1234', marketEmployeeId: '7' },
    ]);
  });

  it('uninstalls by instance id and removes agent plus install directory', async () => {
    const { createDigitalEmployeeUninstallerDependencies, uninstallDigitalEmployee } = await import(
      '@electron/services/digital-employee-uninstaller'
    );

    const dependencies = createDigitalEmployeeUninstallerDependencies({
      readRecord: readInstallRecordMock,
      deleteAgent: deleteAgentMock,
      removeInstallDirectory: removeInstallDirectoryMock,
    });

    const result = await uninstallDigitalEmployee('pkg--1234', dependencies);

    expect(result).toEqual({
      instanceId: 'pkg--1234',
      agentId: 'employee-pkg-1234',
      marketEmployeeId: '7',
    });
    expect(deleteAgentMock).toHaveBeenCalledWith('employee-pkg-1234');
    expect(removeInstallDirectoryMock).toHaveBeenCalledWith('/employees/pkg--1234');
  });

  it('uninstalls by marketplace id', async () => {
    const { createDigitalEmployeeUninstallerDependencies, uninstallDigitalEmployeeByMarketId } = await import(
      '@electron/services/digital-employee-uninstaller'
    );

    const dependencies = createDigitalEmployeeUninstallerDependencies({
      listInstalled: listInstalledMock,
      readRecord: readInstallRecordMock,
      deleteAgent: deleteAgentMock,
      removeInstallDirectory: removeInstallDirectoryMock,
    });

    const result = await uninstallDigitalEmployeeByMarketId('7', dependencies);

    expect(result.marketEmployeeId).toBe('7');
    expect(readInstallRecordMock).toHaveBeenCalled();
  });
});
