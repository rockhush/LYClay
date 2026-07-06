import { describe, expect, it } from 'vitest';
import { deriveTaskSteps, attachSubagentChildSteps, findInFlightChildDelegation, findReplyMessageIndex, isWaitingOnSubagentDelegation, parseSubagentCompletionInfo } from '@/pages/Chat/task-visualization';
import { stripProcessMessagePrefix } from '@/pages/Chat/message-utils';
import type { RawMessage, ToolStatus } from '@/stores/chat';

describe('findReplyMessageIndex', () => {
  it('returns the last assistant text message', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'first narration' },
      { role: 'assistant', content: 'final reply' },
    ];
    expect(findReplyMessageIndex(messages, false)).toBe(2);
  });

  it('skips internal subagent completion markers when picking the reply', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'build ppt' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'spawn-1', name: 'sessions_spawn', input: {} }],
      },
      { role: 'assistant', content: 'PPT 已生成完毕，文件在 workspace。' },
      {
        role: 'assistant',
        content: '[Internal task completion event]\nsession_key: agent:main:subagent:child-1\nsession_id: id-1',
      },
    ];
    // The completion marker is the last text message, but it must not be picked
    // as the reply — the parent wrap-up at index 2 is the real reply.
    expect(findReplyMessageIndex(messages, false)).toBe(2);
  });

  it('returns -1 while a reply is still streaming', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'partial' },
    ];
    expect(findReplyMessageIndex(messages, true)).toBe(-1);
  });

  it('skips interim wait and spawn narration when picking the reply', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'build ppt' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: "I'll spawn a sub-agent to handle this PPTX creation task." },
          { type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'digital-employee-pptx' } },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted' }) }],
      },
      {
        role: 'assistant',
        content: 'PPT 正在生成中，我启动了一个子任务。生成完成后我会通知你，稍等一下～',
        stopReason: 'stop',
      },
      {
        role: 'assistant',
        content: '✅ PPT 已生成完毕！',
        stopReason: 'stop',
      },
    ];
    expect(findReplyMessageIndex(messages, false)).toBe(4);
  });
});

describe('deriveTaskSteps', () => {
  it('builds running steps from streaming thinking and tool status', () => {
    const streamingTools: ToolStatus[] = [
      {
        name: 'web_search',
        status: 'running',
        updatedAt: Date.now(),
        summary: 'Searching docs',
      },
    ];

    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Compare a few approaches before coding.' },
          { type: 'tool_use', id: 'tool-1', name: 'web_search', input: { query: 'openclaw task list' } },
        ],
      },
      streamingTools,
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'stream-thinking-0',
        label: 'Thinking',
        status: 'running',
        kind: 'thinking',
      }),
    ]);
    expect(steps.some((step) => step.label === 'web_search')).toBe(false);
  });

  it('keeps completed tool steps visible while a later tool is still streaming', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-history',
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'read', input: { filePath: '/tmp/a.md' } },
          ],
        },
      ],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-grep', name: 'grep', input: { pattern: 'TODO' } },
        ],
      },
      streamingTools: [
        {
          toolCallId: 'tool-grep',
          name: 'grep',
          status: 'running',
          updatedAt: Date.now(),
          summary: 'Scanning files',
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'completed',
        kind: 'tool',
      }),
    ]);
    expect(steps.some((step) => step.label === 'grep')).toBe(false);
  });

  it('hides non-whitelisted tool steps such as exec and cron from the execution graph', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-history',
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'read', input: { path: '/tmp/skill.md' } },
            { type: 'tool_use', id: 'tool-exec-1', name: 'exec', input: { command: 'python -c "print(1)"' } },
            { type: 'tool_use', id: 'tool-exec-2', name: 'exec', input: { command: 'uv pip install pypinyin' } },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [
        {
          toolCallId: 'tool-exec-live',
          name: 'exec',
          status: 'running',
          updatedAt: Date.now(),
          summary: 'uv run python -c ...',
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        kind: 'tool',
      }),
    ]);
    expect(steps.some((step) => step.label === 'exec')).toBe(false);
  });

  it('hides cron and process tool steps while keeping read and write', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'read', input: { path: '/tmp/a.md' } },
            { type: 'tool_use', id: 'tool-write', name: 'write', input: { path: '/tmp/b.md' } },
            { type: 'tool_use', id: 'tool-cron', name: 'cron', input: { action: 'add' } },
            { type: 'tool_use', id: 'tool-process', name: 'process', input: { step: 1 } },
            { type: 'tool_use', id: 'tool-pdf', name: 'pdf', input: { path: '/tmp/a.pdf' } },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps.map((step) => step.label)).toEqual(['read', 'write']);
  });

  it('upgrades a completed historical tool step when streaming status reports a later state', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-history',
          content: [
            { type: 'tool_use', id: 'tool-read', name: 'read', input: { filePath: '/tmp/a.md' } },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [
        {
          toolCallId: 'tool-read',
          name: 'read',
          status: 'error',
          updatedAt: Date.now(),
          summary: 'Permission denied',
        },
      ],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'error',
        kind: 'tool',
        detail: 'Permission denied',
      }),
    ]);
  });

  it('keeps all steps when the execution graph exceeds the previous max length', () => {
    const messages: RawMessage[] = Array.from({ length: 9 }, (_, index) => ({
      role: 'assistant',
      id: `assistant-${index}`,
      content: [
        { type: 'tool_use', id: `tool-${index}`, name: `read_${index}`, input: { filePath: `/tmp/${index}.md` } },
      ],
    }));

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-live', name: 'grep_live', input: { pattern: 'TODO' } },
        ],
      },
      streamingTools: [
        {
          toolCallId: 'tool-live',
          name: 'grep_live',
          status: 'running',
          updatedAt: Date.now(),
          summary: 'Scanning current workspace',
        },
      ],
    });

    expect(steps).toHaveLength(9);
    expect(steps[0]).toEqual(expect.objectContaining({
      id: 'tool-0',
      label: 'read_0',
      status: 'completed',
    }));
    expect(steps.some((step) => step.label === 'grep_live')).toBe(false);
  });

  it('keeps recent completed steps from assistant history', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        id: 'assistant-1',
        content: [
          { type: 'thinking', thinking: 'Reviewing the code path.' },
          { type: 'tool_use', id: 'tool-2', name: 'read_file', input: { path: 'src/App.tsx' } },
        ],
      },
    ];

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'history-thinking-assistant-1-0',
        label: 'Thinking',
        status: 'completed',
        kind: 'thinking',
      }),
      expect.objectContaining({
        id: 'tool-2',
        label: 'read_file',
        status: 'completed',
        kind: 'tool',
      }),
    ]);
  });

  it('splits cumulative streaming thinking into separate execution steps', () => {
    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Reviewing X.' },
          { type: 'thinking', thinking: 'Reviewing X. Comparing Y.' },
          { type: 'thinking', thinking: 'Reviewing X. Comparing Y. Drafting answer.' },
        ],
      },
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'stream-thinking-0',
        detail: 'Reviewing X.',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'stream-thinking-1',
        detail: 'Comparing Y.',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'stream-thinking-2',
        detail: 'Drafting answer.',
        status: 'running',
      }),
    ]);
  });

  it('filters heartbeat text from execution graph narration', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-heartbeat',
          content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
        },
      ],
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: 'HEARTBEAT_OK' }],
      },
      streamingTools: [],
    });

    expect(steps).toEqual([]);
  });

  it('filters OpenClaw heartbeat poll text from execution graph narration', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-heartbeat-poll',
          content: [{ type: 'text', text: '[OpenClaw heartbeat poll]' }],
        },
      ],
      streamingMessage: {
        role: 'assistant',
        content: [{ type: 'text', text: '[OpenClaw heartbeat poll]' }],
      },
      streamingTools: [],
    });

    expect(steps).toEqual([]);
  });

  it('filters model-generated command approval narration while keeping real tool calls', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-approval-noise',
          content: [
            { type: 'text', text: '请批准查看图标目录： > `dir tabler-filled 图标库`' },
            {
              type: 'tool_use',
              id: 'exec-1',
              name: 'exec',
              input: { command: 'dir C:\\Users\\Leon.Long\\.openclaw\\skills\\ppt-master\\templates\\icons\\tabler-filled', timeout: 10 },
            },
            { type: 'text', text: '请批准搜索所需图标： > `findstr building users chart map flame rocket laptop camera tree beach award star world`' },
            {
              type: 'tool_use',
              id: 'exec-2',
              name: 'exec',
              input: { command: 'Get-ChildItem tabler-filled | Select-String building|users|chart|map' },
            },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([]);
  });

  it('filters approve-token command narration from execution graph', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-approve-token',
          content: [
            {
              type: 'text',
              text: '需要你批准执行项目初始化命令。这是 project_manager.py init 创建 PPT 项目结构的第一步。请回复 /approve d0aebe53 来放行。',
            },
            {
              type: 'tool_use',
              id: 'exec-token',
              name: 'exec',
              input: { command: 'uv run python project_manager.py init shenzhen_intro --format ppt169' },
            },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([]);
  });

  it('filters short approve-token followup narration from execution graph', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-approve-followup',
          content: [
            { type: 'text', text: '继续批一下：`/approve 954d3c37`' },
            {
              type: 'tool_use',
              id: 'write-after-approval',
              name: 'write',
              input: { path: 'design_spec.md', content: 'ok' },
            },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({ id: 'write-after-approval', label: 'write', kind: 'tool' }),
    ]);
  });

  it('keeps normal process narration that is not a command approval request', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-normal-narration',
          content: [
            { type: 'text', text: '图标只显示了最后几个。让我用更完整的方式搜索所需图标。' },
            {
              type: 'tool_use',
              id: 'exec-normal',
              name: 'exec',
              input: { command: 'Get-ChildItem tabler-filled' },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant-final',
          content: [{ type: 'text', text: '已经找到合适的图标。' }],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'history-message-assistant-normal-narration-0',
        kind: 'message',
        detail: '图标只显示了最后几个。让我用更完整的方式搜索所需图标。',
      }),
    ]);
  });

  it('keeps earlier reply segments in the graph when the last streaming segment is rendered separately', () => {
    const steps = deriveTaskSteps({
      messages: [],
      streamingMessage: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checked X.' },
          { type: 'text', text: 'Checked X. Checked Snowball.' },
          { type: 'text', text: 'Checked X. Checked Snowball. Here is the summary.' },
        ],
      },
      streamingTools: [],
      omitLastStreamingMessageSegment: true,
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'stream-message-0',
        detail: 'Checked X.',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'stream-message-1',
        detail: 'Checked Snowball.',
        status: 'completed',
      }),
    ]);
  });

  it('folds earlier reply segments into the graph but leaves the final answer for the chat bubble', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-reply',
          content: [
            { type: 'text', text: 'Checked X.' },
            { type: 'text', text: 'Checked X. Checked Snowball.' },
            { type: 'text', text: 'Checked X. Checked Snowball. Here is the summary.' },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'history-message-assistant-reply-0',
        detail: 'Checked X.',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'history-message-assistant-reply-1',
        detail: 'Checked Snowball.',
        status: 'completed',
      }),
    ]);
  });

  it('strips folded process narration from the final reply text', () => {
    expect(stripProcessMessagePrefix(
      'Checked X. Checked Snowball. Here is the summary.',
      ['Checked X.', 'Checked Snowball.'],
    )).toBe('Here is the summary.');
  });

  it('strips long skill process prefixes without regex stack overflow', () => {
    const line = '检测 browser 工具 LYClaw browser 功能检测';
    const processBlock = Array.from({ length: 120 }, () => line).join(' ');
    const reply = `${processBlock} 最终答案在这里。`;
    expect(() => stripProcessMessagePrefix(reply, [processBlock])).not.toThrow();
    expect(stripProcessMessagePrefix(reply, [processBlock])).toBe('最终答案在这里。');
  });

  it('hides subagent orchestration tool rows while keeping branch system nodes', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        id: 'assistant-2',
        content: [
          {
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { agentId: 'coder', task: 'inspect repo' },
          },
          {
            type: 'tool_use',
            id: 'yield-1',
            name: 'sessions_yield',
            input: { message: 'wait coder finishes' },
          },
        ],
      },
    ];

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps.some((step) => step.label === 'sessions_spawn')).toBe(false);
    expect(steps.some((step) => step.label === 'sessions_yield')).toBe(false);
    expect(steps.some((step) => step.detail?.includes('Spawned branch'))).toBe(true);
  });

  it('keeps subagent orchestration narration in graph message steps', () => {
    const messages: RawMessage[] = [
      {
        role: 'assistant',
        id: 'assistant-3',
        content: [{ type: 'text', text: '我先调度子agent 去检查仓库，稍等。' }],
      },
      {
        role: 'assistant',
        id: 'assistant-4',
        content: [{ type: 'text', text: '检查完成，结论如下。' }],
      },
      {
        role: 'assistant',
        id: 'assistant-5',
        content: [{ type: 'text', text: '这是最终答复。' }],
      },
    ];

    const steps = deriveTaskSteps({
      messages,
      streamingMessage: null,
      streamingTools: [],
    });

    // Intermediate narration is folded into the graph; only the final reply
    // (assistant-5) goes to the bubble, so both narration lines stay in steps.
    expect(steps.some((step) => step.detail?.includes('调度子agent'))).toBe(true);
    expect(steps.some((step) => step.detail?.includes('检查完成'))).toBe(true);
  });

  it('parses internal subagent completion events from injected user messages', () => {
    const info = parseSubagentCompletionInfo({
      role: 'user',
      content: [{
        type: 'text',
        text: `[Internal task completion event]
source: subagent
session_key: agent:coder:subagent:child-123
session_id: child-session-id
status: completed successfully`,
      }],
    } as RawMessage);

    expect(info).toEqual({
      sessionKey: 'agent:coder:subagent:child-123',
      sessionId: 'child-session-id',
      agentId: 'coder',
    });
  });
});

describe('findInFlightChildDelegation', () => {
  it('returns child session info after spawn until completion event arrives', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'Research labor law' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { label: 'legal-research', task: 'collect statutes' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'accepted',
            childSessionKey: 'agent:main:subagent:child-123',
            runId: 'child-run-id',
          }),
        }],
      },
    ];

    const delegation = findInFlightChildDelegation(messages, new Set());
    expect(delegation).toEqual({
      label: 'legal-research',
      childSessionKey: 'agent:main:subagent:child-123',
      runId: 'child-run-id',
    });

    const completed = findInFlightChildDelegation(
      messages,
      new Set(['agent:main:subagent:child-123']),
    );
    expect(completed).toBeNull();

    const stillProcessing = findInFlightChildDelegation(
      messages,
      new Set(['agent:main:subagent:child-123']),
      ['agent:main:subagent:child-123'],
    );
    expect(stillProcessing?.childSessionKey).toBe('agent:main:subagent:child-123');
  });

  it('detects waiting state while child delegation is in flight', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'Research labor law' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { label: 'legal-research', task: 'collect statutes' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'accepted',
            childSessionKey: 'agent:main:subagent:child-123',
            runId: 'child-run-id',
          }),
        }],
      },
    ];

    expect(isWaitingOnSubagentDelegation(messages)).toBe(true);
  });

  it('stays waiting when an earlier child completed but a later spawn is still in flight', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'Build deck' },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-1',
          name: 'sessions_spawn',
          input: { taskName: 'first-pass' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{
          type: 'text',
          text: JSON.stringify({
            childSessionKey: 'agent:main:subagent:child-1',
          }),
        }],
      },
      {
        role: 'user',
        content: '[Internal task completion event] session_key: agent:main:subagent:child-1 session_id: child-1-id',
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-2',
          name: 'sessions_spawn',
          input: { taskName: 'second-pass' },
        }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-2',
        content: [{
          type: 'text',
          text: JSON.stringify({
            childSessionKey: 'agent:main:subagent:child-2',
          }),
        }],
      },
    ];

    expect(isWaitingOnSubagentDelegation(messages)).toBe(true);
    expect(findInFlightChildDelegation(
      messages,
      new Set(['agent:main:subagent:child-1']),
    )).toEqual({
      label: 'second-pass',
      childSessionKey: 'agent:main:subagent:child-2',
      runId: null,
    });
  });
});

describe('post-spawn parent topology', () => {
  it('keeps the parent\'s own steps at top level after a sessions_spawn (not nested under the branch)', () => {
    // Reproduces the case where the subagent times out and the main agent
    // continues working inline. Those parent tool steps must stay at agent
    // level, not collapse under the "<task> run" subagent branch.
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-spawn',
          content: [{
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { taskName: 'ppt_digital_employee', mode: 'run' },
          }],
        },
        {
          role: 'assistant',
          id: 'assistant-takeover',
          content: [
            { type: 'tool_use', id: 'tool-write', name: 'write', input: { path: 'build.js' } },
            { type: 'tool_use', id: 'tool-exec', name: 'exec', input: { command: 'node build.js' } },
          ],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    const branchNode = steps.find((step) => step.id === 'spawn-1:branch');
    expect(branchNode).toBeTruthy();

    for (const id of ['tool-write'] as const) {
      const step = steps.find((s) => s.id === id);
      expect(step?.parentId).toBe('agent-run');
      expect(step?.depth).toBe(1);
    }
    expect(steps.some((step) => step.id === 'tool-exec')).toBe(false);
  });
});

describe('spawn branch labeling', () => {
  it('uses the spawn taskName for the branch label when no agentId is provided', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-spawn',
          content: [{
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { taskName: 'ppt_digital_employee', task: 'build a deck', mode: 'run' },
          }],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    const branchStep = steps.find((step) => step.id === 'spawn-1:branch');
    expect(branchStep?.label).toBe('ppt_digital_employee run');
  });

  it('still prefers agentId over taskName for the branch label', () => {
    const steps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-spawn',
          content: [{
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { agentId: 'coder', taskName: 'ppt_digital_employee' },
          }],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    expect(steps.find((step) => step.id === 'spawn-1:branch')?.label).toBe('coder run');
  });
});

describe('attachSubagentChildSteps', () => {
  it('nests child transcript steps under the spawn branch in the execution graph', () => {
    const parentSteps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-spawn',
          content: [{
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { agentId: 'coder', task: 'inspect repo' },
          }],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    const merged = attachSubagentChildSteps(
      parentSteps,
      [
        {
          role: 'assistant',
          id: 'child-assistant',
          content: [{
            type: 'tool_use',
            id: 'tool-child-read',
            name: 'read',
            input: { path: 'README.md' },
          }],
        },
      ],
      'child-session-id',
      { branchLabel: 'coder' },
    );

    const branchStep = merged.find((step) => step.id === 'spawn-1:branch');
    expect(branchStep).toEqual(expect.objectContaining({
      label: 'coder run',
      depth: 2,
      parentId: 'spawn-1',
    }));

    const childToolStep = merged.find((step) => step.id === 'child-session-id:tool-child-read');
    expect(childToolStep).toEqual(expect.objectContaining({
      label: 'read',
      depth: 3,
      parentId: 'spawn-1:branch',
    }));
  });

  it('shows a running branch placeholder while waiting for child transcript', () => {
    const merged = attachSubagentChildSteps(
      [],
      [],
      'agent:main:subagent:child-123',
      { branchLabel: 'legal-research' },
    );

    expect(merged).toEqual([
      expect.objectContaining({
        id: 'agent:main:subagent:child-123:branch',
        label: 'legal-research run',
        status: 'running',
        depth: 2,
        parentId: 'agent-run',
      }),
    ]);
  });

  it('nests each child transcript under its own spawn branch when multiple spawns exist', () => {
    const parentSteps = deriveTaskSteps({
      messages: [
        {
          role: 'assistant',
          id: 'assistant-spawn-1',
          content: [{
            type: 'tool_use',
            id: 'spawn-1',
            name: 'sessions_spawn',
            input: { taskName: 'first-pass' },
          }],
        },
        {
          role: 'assistant',
          id: 'assistant-spawn-2',
          content: [{
            type: 'tool_use',
            id: 'spawn-2',
            name: 'sessions_spawn',
            input: { taskName: 'second-pass' },
          }],
        },
      ],
      streamingMessage: null,
      streamingTools: [],
    });

    const merged = attachSubagentChildSteps(
      parentSteps,
      [{
        role: 'assistant',
        id: 'child-assistant',
        content: [{
          type: 'tool_use',
          id: 'tool-child-read',
          name: 'read',
          input: { path: 'README.md' },
        }],
      }],
      'agent:main:subagent:child-1',
      { branchLabel: 'first-pass', spawnStepId: 'spawn-1' },
    );

    const childToolStep = merged.find((step) => step.id === 'agent:main:subagent:child-1:tool-child-read');
    expect(childToolStep).toEqual(expect.objectContaining({
      parentId: 'spawn-1:branch',
      depth: 3,
    }));
    expect(merged.find((step) => step.id === 'spawn-2:branch')).toBeTruthy();
  });
});
