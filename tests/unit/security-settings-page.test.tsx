import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SecuritySettings } from '@/pages/Settings/SecuritySettings';
import { hostApiFetch } from '@/lib/host-api';

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const translations = (await import('@/i18n/locales/zh/settings.json')).default as Record<string, unknown>;
  return {
    useTranslation: () => ({
      t: (key: string, variables?: Record<string, unknown>) => {
        const value = key.split('.').reduce<unknown>((current, part) => {
          if (!current || typeof current !== 'object') return undefined;
          return (current as Record<string, unknown>)[part];
        }, translations);
        if (typeof value !== 'string') return key;
        return value.replace(/{{(\w+)}}/g, (_match, name: string) => String(variables?.[name] ?? ''));
      },
    }),
  };
});

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const grantsResponse = {
  pathGrants: [
    {
      id: 'path-1',
      subject: 'user',
      resourceType: 'workspace',
      path: 'D:\\code\\ClawX',
      realPath: 'D:\\code\\ClawX',
      recursive: true,
      capabilities: ['read', 'write'],
      scope: 'session',
      source: 'dialog',
      createdAt: 1_700_000_000_000,
    },
  ],
  domainGrants: [
    {
      id: 'domain-1',
      subject: 'user',
      resourceType: 'domain',
      domain: 'example.net',
      includeSubdomains: true,
      capabilities: ['connect'],
      scope: 'persistent',
      source: 'settings:security',
      createdAt: 1_700_000_000_000,
    },
  ],
  commandGrants: [
    {
      id: 'command-1',
      subject: 'user',
      resourceType: 'command',
      command: 'npm install left-pad',
      fingerprint: 'command-fp-1',
      cwd: 'D:\\code\\ClawX',
      capabilities: ['execute'],
      scope: 'session',
      source: 'gateway:runtime-exec',
      createdAt: 1_700_000_000_000,
    },
  ],
  mcpServerGrants: [
    {
      id: 'mcp-1',
      subject: 'user',
      resourceType: 'mcpServer',
      serverName: 'example-mcp',
      transport: 'stdio',
      fingerprint: 'mcp-fp-1',
      capabilities: ['enable'],
      scope: 'session',
      source: 'settings:mcp-enable',
      createdAt: 1_700_000_000_000,
    },
  ],
  skillGrants: [
    {
      id: 'skill-1',
      subject: 'skill',
      resourceType: 'skill',
      skillId: 'safe-skill',
      manifestDigest: '1234567890abcdef',
      capabilities: ['filesystem:workspace:read', 'network:api.example.com'],
      scope: 'persistent',
      source: 'skill:uploadZip',
      createdAt: 1_700_000_000_000,
    },
  ],
};

const auditResponse = {
  success: true,
  total: 12,
  page: 1,
  pageSize: 10,
  totalPages: 2,
  events: [
    {
      id: 'audit-1',
      ts: 1_700_000_100_000,
      source: 'gateway:rpc',
      capability: 'network',
      operation: 'connect',
      target: 'https://example.net/',
      decision: 'prompt',
      risk: 'medium',
      reasons: ['Network access to example.net requires confirmation'],
    },
    {
      id: 'audit-2',
      ts: 1_700_000_200_000,
      source: 'renderer:test',
      capability: 'command',
      operation: 'execute',
      target: 'npm install left-pad',
      decision: 'deny',
      risk: 'high',
      code: 'COMMAND_DENIED',
    },
  ],
};

function mockHostApiDefaults() {
  vi.mocked(hostApiFetch).mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/api/security/settings') return { success: true, mode: 'trusted' };
    if (path.startsWith('/api/security/audit-events')) return auditResponse;
    if (path === '/api/security/grants/domain' && init?.method === 'POST') {
      return { success: true, grant: grantsResponse.domainGrants[0] };
    }
    if (path.startsWith('/api/security/grants/') && init?.method === 'DELETE') {
      return { success: true };
    }
    return grantsResponse;
  });
}

describe('SecuritySettings', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHostApiDefaults();
  });

  it('renders only path and domain grants in the grants panel', async () => {
    render(
      <MemoryRouter>
        <SecuritySettings />
      </MemoryRouter>,
    );

    expect(await screen.findByText('example.net')).toBeInTheDocument();
    expect(screen.getByText('D:\\code\\ClawX')).toBeInTheDocument();
    expect(screen.getByText('connect')).toBeInTheDocument();
    expect(screen.getByText('递归')).toBeInTheDocument();

    // MCP / Skill / command grant sections were removed from the page even
    // though the API still returns them. They must not render in the grants panel.
    expect(screen.queryByText('example-mcp')).not.toBeInTheDocument();
    expect(screen.queryByText('safe-skill')).not.toBeInTheDocument();
    expect(screen.queryByText('network:api.example.com')).not.toBeInTheDocument();
    expect(screen.queryByText('enable')).not.toBeInTheDocument();
    // "npm install left-pad" still appears in the audit tab, but not the grants panel.
    expect(screen.queryByText('MCP 服务授权')).not.toBeInTheDocument();
    expect(screen.queryByText('Skill 授权')).not.toBeInTheDocument();
    expect(screen.queryByText('命令授权')).not.toBeInTheDocument();
  });

  it('selects trusted mode by default', async () => {
    render(
      <MemoryRouter>
        <SecuritySettings />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('security-mode-trusted')).toHaveAttribute('aria-pressed', 'true');
    });
    expect(screen.getByTestId('security-mode-standard')).toHaveAttribute('aria-pressed', 'false');
  });

  it('adds a domain grant and refreshes the list', async () => {
    render(
      <MemoryRouter>
        <SecuritySettings />
      </MemoryRouter>,
    );

    fireEvent.change(await screen.findByLabelText('域名'), {
      target: { value: 'new.example.net' },
    });
    fireEvent.click(screen.getByRole('button', { name: /添加/ }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/security/grants/domain', {
        method: 'POST',
        body: JSON.stringify({
          domain: 'new.example.net',
          includeSubdomains: true,
          persistent: true,
        }),
      });
    });
  });

  it('revokes a domain grant and refreshes the list', async () => {
    render(
      <MemoryRouter>
        <SecuritySettings />
      </MemoryRouter>,
    );

    expect(await screen.findByText('example.net')).toBeInTheDocument();
    const revokeButtons = screen.getAllByRole('button', { name: /撤销/ });
    fireEvent.click(revokeButtons[0]!);

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/security/grants/domain/domain-1', {
        method: 'DELETE',
      });
    });
  });

  it('renders and filters security audit events', async () => {
    render(
      <MemoryRouter>
        <SecuritySettings />
      </MemoryRouter>,
    );

    const grantsTab = await screen.findByRole('tab', { name: '授权管理' });
    grantsTab.focus();
    fireEvent.keyDown(grantsTab, { key: 'ArrowRight' });

    expect(await screen.findByText('https://example.net/')).toBeInTheDocument();
    expect(screen.getByText('npm install left-pad')).toBeInTheDocument();
    expect(screen.getByText('COMMAND_DENIED')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('能力'), {
      target: { value: 'command' },
    });
    fireEvent.change(screen.getByLabelText('结果'), {
      target: { value: 'deny' },
    });

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/security/audit-events?page=1&pageSize=10&capability=command&decision=deny');
    });
  });

  it('paginates audit events and resets to the first page when filters change', async () => {
    render(
      <MemoryRouter>
        <SecuritySettings />
      </MemoryRouter>,
    );

    const grantsTab = await screen.findByRole('tab', { name: '授权管理' });
    grantsTab.focus();
    fireEvent.keyDown(grantsTab, { key: 'ArrowRight' });

    expect(await screen.findByText('显示第 1-10 条，共 12 条')).toBeInTheDocument();
    expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/security/audit-events?page=2&pageSize=10');
    });

    fireEvent.change(screen.getByLabelText('能力'), {
      target: { value: 'network' },
    });

    await waitFor(() => {
      expect(hostApiFetch).toHaveBeenCalledWith('/api/security/audit-events?page=1&pageSize=10&capability=network');
    });
  });
});
