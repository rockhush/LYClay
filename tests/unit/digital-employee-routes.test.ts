import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const installDigitalEmployeeMock = vi.fn();
const updateDigitalEmployeeMock = vi.fn();
const uninstallDigitalEmployeeMock = vi.fn();
const uninstallDigitalEmployeeByMarketIdMock = vi.fn();
const listLocalDigitalEmployeesMock = vi.fn();
const setDigitalEmployeeEnabledMock = vi.fn();
const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const listAgentsSnapshotMock = vi.fn();

vi.mock('@electron/services/digital-employee-installer', () => ({
  installDigitalEmployee: (...args: unknown[]) => installDigitalEmployeeMock(...args),
}));

vi.mock('@electron/services/digital-employee-updater', () => ({
  updateDigitalEmployee: (...args: unknown[]) => updateDigitalEmployeeMock(...args),
}));

vi.mock('@electron/services/digital-employee-uninstaller', () => ({
  uninstallDigitalEmployee: (...args: unknown[]) => uninstallDigitalEmployeeMock(...args),
  uninstallDigitalEmployeeByMarketId: (...args: unknown[]) => uninstallDigitalEmployeeByMarketIdMock(...args),
}));

vi.mock('@electron/utils/digital-employee-storage', () => ({
  listLocalDigitalEmployees: (...args: unknown[]) => listLocalDigitalEmployeesMock(...args),
  setDigitalEmployeeEnabled: (...args: unknown[]) => setDigitalEmployeeEnabledMock(...args),
}));

vi.mock('@electron/utils/agent-config', () => ({
  listAgentsSnapshot: (...args: unknown[]) => listAgentsSnapshotMock(...args),
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

describe('digital employee routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listAgentsSnapshotMock.mockResolvedValue({
      agents: [{ id: 'agent-1' }],
    });
  });

  it('lists locally installed digital employees', async () => {
    listLocalDigitalEmployeesMock.mockResolvedValue([{ instanceId: 'emp-1', agentId: 'agent-1' }]);
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    const handled = await handleDigitalEmployeeRoutes(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      [{ instanceId: 'emp-1', agentId: 'agent-1' }],
    );
  });

  it('installs a marketplace package and reloads the Gateway', async () => {
    parseJsonBodyMock.mockResolvedValue({
      marketEmployeeId: 7,
      packageSha256: 'abc',
    });
    installDigitalEmployeeMock.mockResolvedValue({
      instanceId: 'emp-1',
      agentId: 'document-analyst',
      sessionKey: 'agent:document-analyst:main',
      status: 'active',
      warnings: [],
    });
    const debouncedReload = vi.fn();
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    const handled = await handleDigitalEmployeeRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/install'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(handled).toBe(true);
    expect(installDigitalEmployeeMock).toHaveBeenCalledWith({
      marketEmployeeId: '7',
      packageSha256: 'abc',
    });
    expect(debouncedReload).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, instanceId: 'emp-1' }),
    );
  });

  it('does not reload the Gateway after a rolled-back install failure', async () => {
    parseJsonBodyMock.mockResolvedValue({
      marketEmployeeId: '7',
    });
    installDigitalEmployeeMock.mockRejectedValue(new Error('install failed'));
    const debouncedReload = vi.fn();
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    await handleDigitalEmployeeRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/install'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(debouncedReload).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({ success: false }),
    );
  });

  it('does not reload the Gateway when update finds no newer package', async () => {
    parseJsonBodyMock.mockResolvedValue({});
    updateDigitalEmployeeMock.mockRejectedValue(
      new Error('Update version 1.0.0 must be newer than installed version 1.0.0'),
    );
    const debouncedReload = vi.fn();
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    await handleDigitalEmployeeRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/document-analyst--1234/update'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(debouncedReload).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      500,
      expect.objectContaining({ success: false }),
    );
  });

  it('updates an installed digital employee and reloads the Gateway', async () => {
    parseJsonBodyMock.mockResolvedValue({
      packageSha256: 'def',
    });
    updateDigitalEmployeeMock.mockResolvedValue({
      instanceId: 'document-analyst--1234',
      agentId: 'employee-document-analyst-1234',
      fromVersion: '1.0.0',
      toVersion: '1.1.0',
      status: 'active',
      warnings: [],
    });
    const debouncedReload = vi.fn();
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    const handled = await handleDigitalEmployeeRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/document-analyst--1234/update'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(handled).toBe(true);
    expect(updateDigitalEmployeeMock).toHaveBeenCalledWith(
      'document-analyst--1234',
      {
        packageSha256: 'def',
      },
    );
    expect(debouncedReload).toHaveBeenCalledTimes(1);
  });

  it('uninstalls an installed digital employee and reloads the Gateway', async () => {
    parseJsonBodyMock.mockResolvedValue({
      marketEmployeeId: '7',
    });
    uninstallDigitalEmployeeByMarketIdMock.mockResolvedValue({
      instanceId: 'emp-1',
      agentId: 'agent-1',
      marketEmployeeId: '7',
    });
    const debouncedReload = vi.fn();
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    const handled = await handleDigitalEmployeeRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/uninstall'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(handled).toBe(true);
    expect(uninstallDigitalEmployeeByMarketIdMock).toHaveBeenCalledWith('7');
    expect(debouncedReload).toHaveBeenCalledTimes(1);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, instanceId: 'emp-1' }),
    );
  });

  it('does not reload the Gateway after an uninstall failure', async () => {
    parseJsonBodyMock.mockResolvedValue({ marketEmployeeId: '7' });
    uninstallDigitalEmployeeByMarketIdMock.mockRejectedValue(new Error('uninstall failed'));
    const debouncedReload = vi.fn();
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    await handleDigitalEmployeeRoutes(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/uninstall'),
      { gatewayManager: { debouncedReload } } as never,
    );

    expect(debouncedReload).not.toHaveBeenCalled();
  });

  it('updates enabled state for an installed digital employee', async () => {
    parseJsonBodyMock.mockResolvedValue({ enabled: false });
    setDigitalEmployeeEnabledMock.mockResolvedValue({
      instanceId: 'emp-1',
      userEnabled: false,
    });
    const { handleDigitalEmployeeRoutes } = await import('@electron/api/routes/digital-employees');

    const handled = await handleDigitalEmployeeRoutes(
      { method: 'PUT' } as IncomingMessage,
      {} as ServerResponse,
      new URL('http://127.0.0.1:13210/api/digital-employees/emp-1/enabled'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(setDigitalEmployeeEnabledMock).toHaveBeenCalledWith('emp-1', false);
    expect(sendJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, instanceId: 'emp-1', enabled: false }),
    );
  });
});
