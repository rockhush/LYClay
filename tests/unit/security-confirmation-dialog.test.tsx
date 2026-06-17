import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SecurityConfirmationDialog } from '@/components/security/SecurityConfirmationDialog';

describe('SecurityConfirmationDialog', () => {
  const invokeMock = vi.fn();
  let listener: ((payload: unknown) => void) | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    listener = null;
    (window as unknown as {
      electron: {
        ipcRenderer: {
          invoke: typeof invokeMock;
          on: (channel: string, callback: (payload: unknown) => void) => () => void;
        };
      };
    }).electron = {
      ipcRenderer: {
        invoke: invokeMock,
        on: vi.fn((_channel, callback) => {
          listener = callback;
          return () => { listener = null; };
        }),
      },
    };
  });

  it('shows network confirmation details and returns persistent allow choice', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-1',
        kind: 'network',
        source: 'gateway:rpc:chat.send',
        risk: 'medium',
        target: {
          url: 'https://www.baidu.com/',
          hostname: 'www.baidu.com',
        },
        reasons: ['Network access to www.baidu.com requires confirmation'],
      });
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText('www.baidu.com')).toBeInTheDocument();
    expect(screen.getByText(/当前对话/)).toBeInTheDocument();
    expect(screen.getByText(/风险：中/)).toBeInTheDocument();
    expect(screen.getByText(/访问 www.baidu.com 需要你的确认/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本次启动允许' })).toBeInTheDocument();
    expect(screen.queryByText(/requires confirmation/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '永久允许' }));

    expect(invokeMock).toHaveBeenCalledWith('security:confirmation-response', {
      id: 'confirm-1',
      choice: 'allow-persistent',
    });
  });

  it('sends deny when Escape is pressed', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-2',
        kind: 'network',
        source: 'gateway:rpc:chat.send',
        risk: 'medium',
        target: {
          url: 'https://www.baidu.com/',
          hostname: 'www.baidu.com',
        },
        reasons: [],
      });
    });

    const dialog = await screen.findByTestId('security-confirmation-dialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });

    expect(invokeMock).toHaveBeenCalledWith('security:confirmation-response', {
      id: 'confirm-2',
      choice: 'deny',
    });
  });

  it('shows command confirmation without persistent allow', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-command-1',
        kind: 'command',
        source: 'renderer:openclaw-doctor',
        risk: 'medium',
        target: {
          command: 'openclaw doctor --fix --yes --non-interactive',
          cwd: 'D:\\code\\ClawX',
          segments: [],
        },
        reasons: ['Repair commands require explicit user confirmation'],
      });
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText('Agent 想执行命令')).toBeInTheDocument();
    expect(screen.getByText('openclaw doctor --fix --yes --non-interactive')).toBeInTheDocument();
    expect(screen.getByText(/OpenClaw Doctor/)).toBeInTheDocument();
    expect(screen.getByText(/修复类命令可能修改本地环境，需要你的确认/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '永久允许' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '本次启动允许' }));

    expect(invokeMock).toHaveBeenCalledWith('security:confirmation-response', {
      id: 'confirm-command-1',
      choice: 'allow-session',
    });
  });

  it('keeps long command details in a scrollable target area', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-command-long',
        kind: 'command',
        source: 'gateway:runtime-exec',
        risk: 'high',
        target: {
          command: Array.from({ length: 40 }, (_, index) => `Write-Host "line ${index}"`).join('; '),
          cwd: 'D:\\code\\ClawX',
        },
        reasons: ['Command substitution requires confirmation'],
      });
    });

    const target = await screen.findByTestId('security-confirmation-target');
    expect(target).toHaveClass('max-h-56');
    expect(target).toHaveClass('overflow-y-auto');
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
  });

  it('shows open target confirmation without persistent allow', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-open-1',
        kind: 'open-target',
        source: 'renderer:shell.openExternal',
        risk: 'medium',
        target: {
          url: 'mailto:test@example.com',
          protocol: 'mailto:',
        },
        reasons: ['Opening an email client requires confirmation'],
      });
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText('Agent 想打开外部目标')).toBeInTheDocument();
    expect(screen.getByText('mailto:test@example.com')).toBeInTheDocument();
    expect(screen.getByText(/打开邮件客户端需要你的确认/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '永久允许' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '允许一次' }));

    expect(invokeMock).toHaveBeenCalledWith('security:confirmation-response', {
      id: 'confirm-open-1',
      choice: 'allow-once',
    });
  });

  it('shows redacted model-secret details without a persistent allow option', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-model-secret-1',
        kind: 'model-secret',
        source: 'gateway:rpc:chat.send',
        risk: 'high',
        target: {
          summary: '1 secret-like value(s)',
          secretTypes: ['openai-token'],
          excerpts: ['send [REDACTED] to the model'],
        },
        reasons: ['Message content contains secret-like values before model send'],
      });
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText('Agent 想发送疑似敏感密钥')).toBeInTheDocument();
    expect(screen.getByText('1 secret-like value(s)')).toBeInTheDocument();
    expect(screen.getByText('openai-token')).toBeInTheDocument();
    expect(screen.getByText('send [REDACTED] to the model')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '永久允许' })).not.toBeInTheDocument();
  });

  it('shows MCP server confirmation with a persistent allow option', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.({
        id: 'confirm-mcp-1',
        kind: 'mcp-server',
        source: 'settings:mcp-enable',
        risk: 'high',
        target: {
          serverName: 'example',
          transport: 'stdio',
          summary: 'npx -y @example/mcp',
        },
        reasons: ['stdio MCP servers start a local process and require explicit confirmation'],
      });
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText(/example \(stdio\)/)).toBeInTheDocument();
    expect(screen.getByText(/stdio MCP/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '永久允许' }));

    expect(invokeMock).toHaveBeenCalledWith('security:confirmation-response', {
      id: 'confirm-mcp-1',
      choice: 'allow-persistent',
    });
  });

  it('shows file delete confirmation with correct title and icon', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.(({
        id: 'confirm-file-delete-1',
        kind: 'file',
        source: 'agent',
        risk: 'high',
        target: {
          path: 'D:\\测试\\hello.txt',
          capability: 'delete',
        },
        reasons: ['Delete operations require a confirmation flow'],
      }));
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText('Agent 想删除文件')).toBeInTheDocument();
    expect(screen.getByText('D:\\测试\\hello.txt')).toBeInTheDocument();
    expect(screen.getByText(/删除文件操作需要确认/)).toBeInTheDocument();
    // Should show permanent allow button for file operations
    expect(screen.getByRole('button', { name: '永久允许' })).toBeInTheDocument();
  });

  it('shows file write confirmation with correct title', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.(({
        id: 'confirm-file-write-1',
        kind: 'file',
        source: 'agent',
        risk: 'medium',
        target: {
          path: 'D:\\测试\\output.txt',
          capability: 'write',
        },
        reasons: ['Writing local files requires confirmation'],
      }));
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    expect(screen.getByText('Agent 想写入文件')).toBeInTheDocument();
    expect(screen.getByText(/写入本地文件需要确认/)).toBeInTheDocument();
  });

  it('shows file read confirmation with legacy title when no capability specified', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.(({
        id: 'confirm-file-read-1',
        kind: 'file',
        source: 'agent',
        risk: 'medium',
        target: {
          path: 'D:\\测试\\readme.txt',
        },
        reasons: ['File read requires confirmation'],
      }));
    });

    expect(await screen.findByTestId('security-confirmation-dialog')).toBeInTheDocument();
    // Falls back to legacy read title when no capability
    expect(screen.getByText('Agent 想读取本地文件')).toBeInTheDocument();
  });

  it('sends deny for file delete when user clicks reject', async () => {
    render(<SecurityConfirmationDialog />);

    act(() => {
      listener?.(({
        id: 'confirm-file-deny-1',
        kind: 'file',
        source: 'agent',
        risk: 'high',
        target: {
          path: 'D:\\测试\\important.txt',
          capability: 'delete',
        },
        reasons: ['Delete operations require a confirmation flow'],
      }));
    });

    await screen.findByTestId('security-confirmation-dialog');
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    expect(invokeMock).toHaveBeenCalledWith('security:confirmation-response', {
      id: 'confirm-file-deny-1',
      choice: 'deny',
    });
  });
});
