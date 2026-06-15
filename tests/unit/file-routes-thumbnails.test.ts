import { beforeEach, describe, expect, it, vi } from 'vitest';

const parseJsonBodyMock = vi.fn();
const sendJsonMock = vi.fn();
const assertPathAllowedMock = vi.fn();

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn(),
  },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      resize: vi.fn(),
      toPNG: vi.fn(() => Buffer.from('')),
    })),
  },
}));

vi.mock('@electron/api/route-utils', () => ({
  parseJsonBody: (...args: unknown[]) => parseJsonBodyMock(...args),
  sendJson: (...args: unknown[]) => sendJsonMock(...args),
}));

vi.mock('@electron/security/path-policy', () => ({
  assertPathAllowed: (...args: unknown[]) => assertPathAllowedMock(...args),
}));

describe('file thumbnail routes', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('skips glob and missing preview candidates before path-policy auditing', async () => {
    parseJsonBodyMock.mockResolvedValue({
      paths: [
        { filePath: 'D:\\*.svg', mimeType: 'image/svg+xml' },
        { filePath: '/scripts/README.md', mimeType: 'text/markdown' },
      ],
    });

    const { handleFileRoutes } = await import('@electron/api/routes/files');
    const handled = await handleFileRoutes(
      { method: 'POST' } as never,
      {} as never,
      new URL('http://127.0.0.1:13210/api/files/thumbnails'),
      {} as never,
    );

    expect(handled).toBe(true);
    expect(assertPathAllowedMock).not.toHaveBeenCalled();
    expect(sendJsonMock).toHaveBeenCalledWith(expect.anything(), 200, {
      'D:\\*.svg': { preview: null, fileSize: 0 },
      '/scripts/README.md': { preview: null, fileSize: 0 },
    });
  });
});
