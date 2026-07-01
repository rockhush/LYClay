import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from '@/pages/Chat/ChatInput';
import { TooltipProvider } from '@/components/ui/tooltip';
import { hostApiFetch } from '@/lib/host-api';
import { invokeIpc } from '@/lib/api-client';

const { agentsState, chatState, digitalEmployeesState, gatewayState, skillsState } = vi.hoisted(() => ({
  agentsState: {
    agents: [] as Array<Record<string, unknown>>,
    fetchAgents: vi.fn(),
  },
  digitalEmployeesState: {
    employees: [] as Array<Record<string, unknown>>,
    fetchEmployees: vi.fn(),
  },
  chatState: {
    currentAgentId: 'main',
    currentSessionKey: 'agent:main:main',
    messages: [] as unknown[],
    bindCurrentSessionWorkspace: vi.fn(),
    newSession: vi.fn(),
    reasoningMode: 'fast',
    setReasoningMode: vi.fn(),
  },
  gatewayState: {
    status: { state: 'running', port: 18789, gatewayReady: true, warmupStatus: 'ready' },
    rpc: vi.fn(),
  },
  skillsState: {
    skills: [] as Array<Record<string, unknown>>,
    loading: false,
    fetchSkills: vi.fn(),
  },
}));

vi.mock('@/stores/agents', () => ({
  useAgentsStore: (selector: (state: typeof agentsState) => unknown) => selector(agentsState),
}));

vi.mock('@/stores/digital-employees', () => ({
  useDigitalEmployeesStore: (selector: (state: typeof digitalEmployeesState) => unknown) => selector(digitalEmployeesState),
}));

vi.mock('@/stores/chat', () => ({
  useChatStore: (selector: (state: typeof chatState) => unknown) => selector(chatState),
}));

vi.mock('@/stores/gateway', () => {
  const useGatewayStore = Object.assign(
    (selector: (state: typeof gatewayState) => unknown) => selector(gatewayState),
    { getState: () => gatewayState },
  );
  return { useGatewayStore };
});

vi.mock('@/stores/skills', () => ({
  useSkillsStore: (selector: (state: typeof skillsState) => unknown) => selector(skillsState),
}));

vi.mock('@/lib/host-api', () => ({
  hostApiFetch: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  invokeIpc: vi.fn(),
}));

vi.mock('@/components/workspace/WorkspacePicker', () => ({
  WorkspacePicker: () => <div data-testid="workspace-picker-button" />,
}));

function translate(key: string, vars?: Record<string, unknown>): string {
  switch (key) {
    case 'composer.attachFiles':
      return 'Attach files';
    case 'composer.pickSkill':
      return 'Choose skill';
    case 'composer.skillButton':
      return 'Skill';
    case 'composer.skillPickerTitle':
      return `Quick skill access for ${String(vars?.agent ?? '')}`;
    case 'composer.skillSearchPlaceholder':
      return 'Search skills';
    case 'composer.skillLoading':
      return 'Loading skills...';
    case 'composer.skillEmpty':
      return 'No matching skills found';
    case 'composer.pickAgent':
      return 'Choose agent';
    case 'composer.clearTarget':
      return 'Clear target agent';
    case 'composer.targetChip':
      return `@${String(vars?.agent ?? '')}`;
    case 'composer.agentPickerTitle':
      return 'Route the next message to another agent';
    case 'composer.gatewayDisconnectedPlaceholder':
      return 'Gateway not connected...';
    case 'composer.send':
      return 'Send';
    case 'composer.stop':
      return 'Stop';
    case 'composer.gatewayConnected':
      return 'connected';
    case 'composer.gatewayStatus':
      return `gateway ${String(vars?.state ?? '')} | port: ${String(vars?.port ?? '')} ${String(vars?.pid ?? '')}`.trim();
    case 'composer.retryFailedAttachments':
      return 'Retry failed attachments';
    case 'composer.removeFailedAttachments':
      return 'Remove failed attachments';
    default:
      return key;
  }
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
  }),
}));

function renderChatInput(onSend = vi.fn()) {
  return render(
    <TooltipProvider>
      <ChatInput onSend={onSend} />
    </TooltipProvider>,
  );
}

describe('ChatInput agent targeting', () => {
  beforeEach(() => {
    agentsState.agents = [];
    digitalEmployeesState.employees = [];
    digitalEmployeesState.fetchEmployees = vi.fn();
    chatState.currentAgentId = 'main';
    chatState.currentSessionKey = 'agent:main:main';
    chatState.messages = [];
    chatState.bindCurrentSessionWorkspace = vi.fn();
    chatState.newSession = vi.fn();
    gatewayState.status = { state: 'running', port: 18789, gatewayReady: true, warmupStatus: 'ready' };
    gatewayState.rpc.mockReset();
    gatewayState.rpc.mockResolvedValue({ skills: [] });
    skillsState.skills = [];
    skillsState.loading = false;
    skillsState.fetchSkills = vi.fn();
    vi.mocked(hostApiFetch).mockReset();
    vi.mocked(hostApiFetch).mockResolvedValue({ success: true, results: [] });
    vi.mocked(invokeIpc).mockReset();
  });

  it('shows an empty @agent picker when no digital employees are installed', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderChatInput();

    fireEvent.click(screen.getByTitle('Choose agent'));

    expect(screen.getByText('暂无可用数字员工')).toBeInTheDocument();
    expect(digitalEmployeesState.fetchEmployees).toHaveBeenCalled();
  });

  it('uses native textarea rendering when no skill token is present', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: '我没有填写Skill' } });

    expect(textbox).toHaveValue('我没有填写Skill');
    expect(screen.queryByTestId('chat-composer-skill-token')).not.toBeInTheDocument();
    expect(textbox.className).not.toContain('text-transparent');
  });

  it('lets the user select a digital employee target and sends its agent id with the message', () => {
    const onSend = vi.fn();
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    digitalEmployeesState.employees = [
      {
        instanceId: 'inline-probe--local',
        marketEmployeeId: 'inline-probe',
        packageId: 'inline-probe',
        packageVersion: '1.0.0',
        name: '内联探针数字员工',
        description: 'Probe current-session execution.',
        tags: [],
        installPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\inline-probe--local',
        agentId: 'inline-probe--local',
        sessionKey: 'agent:inline-probe--local:main',
        status: 'active',
        warnings: [],
      },
    ];

    renderChatInput(onSend);

    fireEvent.click(screen.getByTitle('Choose agent'));
    fireEvent.click(screen.getByText('内联探针数字员工'));

    expect(chatState.newSession).not.toHaveBeenCalled();
    expect(screen.getByText('@内联探针数字员工')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello direct agent' } });
    fireEvent.click(screen.getByTitle('Send'));

    expect(chatState.newSession).not.toHaveBeenCalled();
    expect(chatState.currentSessionKey).toBe('agent:main:main');
    expect(chatState.currentAgentId).toBe('main');
    expect(onSend).toHaveBeenCalledWith('Hello direct agent', undefined, 'inline-probe--local');
  });

  it('parses a typed leading @agentId as current-session digital employee execution', () => {
    const onSend = vi.fn();
    digitalEmployeesState.employees = [
      {
        instanceId: 'inline-probe--local',
        marketEmployeeId: 'inline-probe',
        packageId: 'inline-probe',
        packageVersion: '1.0.0',
        name: '内联探针数字员工',
        description: 'Probe current-session execution.',
        tags: [],
        installPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\inline-probe--local',
        agentId: 'inline-probe--local',
        sessionKey: 'agent:inline-probe--local:main',
        status: 'active',
        warnings: [],
      },
    ];

    renderChatInput(onSend);

    fireEvent.change(screen.getByRole('textbox'), { target: { value: '@inline-probe--local 帮我写周报' } });
    fireEvent.click(screen.getByTitle('Send'));

    expect(chatState.newSession).not.toHaveBeenCalled();
    expect(chatState.currentSessionKey).toBe('agent:main:main');
    expect(chatState.currentAgentId).toBe('main');
    expect(onSend).toHaveBeenCalledWith('帮我写周报', undefined, 'inline-probe--local');
  });

  it('does not show repair-required digital employee records in the @agent picker', () => {
    digitalEmployeesState.employees = [
      {
        instanceId: 'document-analyst--old',
        marketEmployeeId: 'document-analyst',
        packageId: 'document-analyst',
        packageVersion: '1.0.0',
        name: '文档分析数字员工',
        description: 'Old broken install.',
        tags: [],
        installPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\document-analyst--old',
        agentId: 'document-analyst--old',
        sessionKey: 'agent:document-analyst--old:main',
        status: 'repair-required',
        warnings: ['The bound OpenClaw Agent is missing'],
      },
      {
        instanceId: 'test11--local',
        marketEmployeeId: 'test11',
        packageId: 'test11',
        packageVersion: '1.0.0',
        name: 'test11',
        description: '',
        tags: [],
        installPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\test11--local',
        agentId: 'test11--local',
        sessionKey: 'agent:test11--local:main',
        status: 'active',
        warnings: [],
      },
    ];

    renderChatInput();

    fireEvent.click(screen.getByTitle('Choose agent'));

    expect(screen.getByText('test11')).toBeInTheDocument();
    expect(screen.queryByText('文档分析数字员工')).not.toBeInTheDocument();
  });

  it('renders the skill trigger after the @ agent picker', () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    digitalEmployeesState.employees = [
      {
        instanceId: 'test11--local',
        marketEmployeeId: 'test11',
        packageId: 'test11',
        packageVersion: '1.0.0',
        name: 'test11',
        description: '',
        tags: [],
        installPath: 'C:\\Users\\test\\.openclaw\\digital-employees\\test11--local',
        agentId: 'test11--local',
        sessionKey: 'agent:test11--local:main',
        status: 'active',
        warnings: [],
      },
    ];

    renderChatInput();

    const agentTrigger = screen.getByTestId('chat-composer-agent');
    const skillTrigger = screen.getByTestId('chat-composer-skill');

    expect(skillTrigger).toBeInTheDocument();
    expect(skillTrigger.compareDocumentPosition(agentTrigger) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hostApiFetch).not.toHaveBeenCalled();
  });

  it('inserts the selected skill at the current cursor position and prefixes sends', async () => {
    const onSend = vi.fn();
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    skillsState.skills = [
        {
          id: 'create-skill',
          skillKey: 'create-skill',
          name: 'create-skill',
          enabled: true,
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ];

    renderChatInput(onSend);

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    expect(await screen.findByText('create-skill')).toBeInTheDocument();

    fireEvent.click(screen.getByText('create-skill'));
    expect(screen.getByTestId('chat-composer-skill')).toBeInTheDocument();
    expect(textbox).toHaveValue('Draft @create-skill 请使用这个技能，帮我 a new helper');

    fireEvent.click(screen.getByTitle('Send'));

    expect(onSend).toHaveBeenCalledWith(
      'Draft @create-skill 请使用这个技能，帮我 a new helper',
      undefined,
      null,
      { skillFilter: ['create-skill'] },
    );
    expect(hostApiFetch).toHaveBeenCalledWith(
      '/api/usage-report/skill-invoke',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(String),
      }),
    );
  });

  it('does not route an unmatched leading skill mention as a digital employee target', () => {
    const onSend = vi.fn();
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
      {
        id: 'calendar-agent',
        name: 'Calendar Agent',
        isDigitalEmployee: true,
        mainSessionKey: 'agent:calendar-agent:main',
      },
    ];

    renderChatInput(onSend);

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: '@undefined-network-skill 查询今天日程' } });
    fireEvent.click(screen.getByTitle('Send'));

    expect(onSend).toHaveBeenCalledWith('@undefined-network-skill 查询今天日程', undefined, null);
  });

  it('removes the full inline skill token with one backspace', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    skillsState.skills = [
        {
          id: 'create-skill',
          skillKey: 'create-skill',
          name: 'create-skill',
          enabled: true,
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ];

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('create-skill'));

    expect(textbox).toHaveValue('Draft @create-skill 请使用这个技能，帮我 a new helper');
    textbox.setSelectionRange('Draft @create-skill 请使用这个技能，帮我 '.length, 'Draft @create-skill 请使用这个技能，帮我 '.length);
    fireEvent.keyDown(textbox, { key: 'Backspace' });

    expect(textbox).toHaveValue('Draft @create-skill 请使用这个技能，帮我 a new helper');
  });

  it('skips across the inline skill block with arrow keys', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    skillsState.skills = [
        {
          id: 'create-skill',
          skillKey: 'create-skill',
          name: 'create-skill',
          enabled: true,
          description: 'Create and refine reusable skills.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-skill/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-skill',
        },
      ];

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: 'Draft a new helper' } });
    textbox.focus();
    textbox.setSelectionRange('Draft '.length, 'Draft '.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('create-skill'));

    textbox.setSelectionRange('Draft '.length, 'Draft '.length);
    fireEvent.keyDown(textbox, { key: 'ArrowRight' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textbox.selectionStart).toBe('Draft @create-skill 请使用这个技能，帮我 '.length);

    fireEvent.keyDown(textbox, { key: 'ArrowLeft' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(textbox.selectionStart).toBe('Draft @create-skill 请使用这个技能，帮我 '.length);
  });

  it('adds left spacing when inserting a skill after adjacent text', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    skillsState.skills = [
        {
          id: 'docx',
          skillKey: 'docx',
          name: 'docx',
          enabled: true,
          description: 'Work with Word documents.',
          source: 'legacy',
          sourceLabel: 'Legacy',
          manifestPath: '/tmp/openclaw/skills/docx/SKILL.md',
          baseDir: '/tmp/openclaw/skills/docx',
        },
      ];

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: '哈哈哈哈你好' } });
    textbox.focus();
    textbox.setSelectionRange('哈哈哈哈'.length, '哈哈哈哈'.length);

    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByText('docx'));

    expect(textbox).toHaveValue('哈哈哈哈 @docx 请使用这个技能，帮我 你好');
  });

  it('allows inserting the same skill multiple times as separate blocks', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    skillsState.skills = [
        {
          id: 'create-rule',
          skillKey: 'create-rule',
          name: 'create-rule',
          enabled: true,
          description: 'Create Cursor rules.',
          source: 'workspace',
          sourceLabel: 'Workspace',
          manifestPath: '/tmp/workspace/skill/create-rule/SKILL.md',
          baseDir: '/tmp/workspace/skill/create-rule',
        },
      ];

    renderChatInput();

    const textbox = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByTestId('chat-composer-skill-option-create-rule'));

    textbox.setSelectionRange(textbox.value.length, textbox.value.length);
    fireEvent.click(screen.getByTitle('Choose skill'));
    fireEvent.click(await screen.findByTestId('chat-composer-skill-option-create-rule'));

    expect(textbox).toHaveValue('@create-rule 请使用这个技能，帮我 @create-rule 请使用这个技能，帮我 ');
    expect(screen.queryByTestId('chat-composer-skill-token')).not.toBeInTheDocument();
  });

  it('shows a clear security reason when attachment staging is blocked', async () => {
    agentsState.agents = [
      {
        id: 'main',
        name: 'Main',
        isDefault: true,
        modelDisplay: 'MiniMax',
        inheritedModel: true,
        workspace: '~/.openclaw/workspace',
        agentDir: '~/.openclaw/agents/main/agent',
        mainSessionKey: 'agent:main:main',
        channelTypes: [],
      },
    ];
    vi.mocked(invokeIpc).mockResolvedValueOnce({
      canceled: false,
      filePaths: ['C:\\Users\\Leon\\.ssh\\id_rsa'],
    });
    vi.mocked(hostApiFetch).mockRejectedValueOnce(new Error('Sensitive path blocked: SSH credentials'));

    renderChatInput();

    fireEvent.click(screen.getByTitle('Attach files'));

    expect(await screen.findByText(/安全策略已阻止此附件/)).toBeInTheDocument();
    expect(screen.getByText('Remove failed attachments')).toBeInTheDocument();
  });
});
