import { beforeEach, describe, expect, it, vi } from 'vitest';

const readInstallRecordMock = vi.fn();
const deleteAgentMock = vi.fn();
const removeInstallDirectoryMock = vi.fn();
const cleanupSub2ApiModelsMock = vi.fn();
const listInstalledMock = vi.fn();
const withDigitalEmployeeInstallLockMock = vi.fn(async (fn: () => Promise<unknown>) => fn());
const removeMcpServersMock = vi.fn();

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
      installedMcpServers: [{ sourceName: 'docs', runtimeName: 'pkg--1234--docs' }],
    });
    deleteAgentMock.mockResolvedValue(undefined);
    removeInstallDirectoryMock.mockResolvedValue(undefined);
    cleanupSub2ApiModelsMock.mockResolvedValue(undefined);
    removeMcpServersMock.mockResolvedValue(undefined);
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
      cleanupSub2ApiModels: cleanupSub2ApiModelsMock,
      removeInstallDirectory: removeInstallDirectoryMock,
      removeMcpServers: removeMcpServersMock,
    });

    const result = await uninstallDigitalEmployee('pkg--1234', dependencies);

    expect(result).toEqual({
      instanceId: 'pkg--1234',
      agentId: 'employee-pkg-1234',
      marketEmployeeId: '7',
    });
    expect(cleanupSub2ApiModelsMock).toHaveBeenCalledWith('pkg--1234');
    expect(deleteAgentMock).toHaveBeenCalledWith('employee-pkg-1234');
    expect(removeMcpServersMock).toHaveBeenCalledWith(['pkg--1234--docs']);
    expect(removeInstallDirectoryMock).toHaveBeenCalledWith('/employees/pkg--1234');
    expect(cleanupSub2ApiModelsMock.mock.invocationCallOrder[0]).toBeLessThan(deleteAgentMock.mock.invocationCallOrder[0]);
    expect(deleteAgentMock.mock.invocationCallOrder[0]).toBeLessThan(removeInstallDirectoryMock.mock.invocationCallOrder[0]);
  });

  it('uninstalls by marketplace id', async () => {
    const { createDigitalEmployeeUninstallerDependencies, uninstallDigitalEmployeeByMarketId } = await import(
      '@electron/services/digital-employee-uninstaller'
    );

    const dependencies = createDigitalEmployeeUninstallerDependencies({
      listInstalled: listInstalledMock,
      readRecord: readInstallRecordMock,
      deleteAgent: deleteAgentMock,
      cleanupSub2ApiModels: cleanupSub2ApiModelsMock,
      removeInstallDirectory: removeInstallDirectoryMock,
      removeMcpServers: removeMcpServersMock,
    });

    const result = await uninstallDigitalEmployeeByMarketId('7', dependencies);

    expect(result.marketEmployeeId).toBe('7');
    expect(readInstallRecordMock).toHaveBeenCalled();
  });
});
