import { closeElectronApp, expect, getStableWindow, installIpcMocks, test } from './fixtures/electron';

const PROJECT_MANAGER_SESSION_KEY = 'agent:main:main';
const CODER_SESSION_KEY = 'agent:coder:subagent:child-123';
const CODER_SESSION_ID = 'child-session-id';

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${entries.join(',')}}`;
}

const seededHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: '[Mon 2026-04-06 15:18 GMT+8] Analyze Velaria uncommitted changes' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'spawn-call',
      name: 'sessions_spawn',
      arguments: { agentId: 'coder', task: 'analyze core blocks' },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'spawn-call',
    toolName: 'sessions_spawn',
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'accepted',
        childSessionKey: CODER_SESSION_KEY,
        runId: 'child-run-id',
        mode: 'run',
      }, null, 2),
    }],
    details: {
      status: 'accepted',
      childSessionKey: CODER_SESSION_KEY,
      runId: 'child-run-id',
      mode: 'run',
    },
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'yield-call',
      name: 'sessions_yield',
      arguments: { message: 'I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.' },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'yield-call',
    toolName: 'sessions_yield',
    content: [{
      type: 'text',
      text: JSON.stringify({
        status: 'yielded',
        message: 'I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.',
      }, null, 2),
    }],
    details: {
      status: 'yielded',
      message: 'I asked coder to break down the core blocks of ~/Velaria uncommitted changes; will give you the conclusion when it returns.',
    },
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'user',
    content: [{
      type: 'text',
      text: `[Internal task completion event]
source: subagent
session_key: ${CODER_SESSION_KEY}
session_id: ${CODER_SESSION_ID}
type: subagent task
status: completed successfully`,
    }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Coder has finished the analysis, here are the conclusions.' }],
    _attachedFiles: [
      {
        fileName: 'CHECKLIST.md',
        mimeType: 'text/markdown',
        fileSize: 433,
        preview: null,
        filePath: '/Users/bytedance/.openclaw/workspace/CHECKLIST.md',
        source: 'tool-result',
      },
    ],
    timestamp: Date.now(),
  },
];

const childTranscriptMessages = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'Analyze the core content of ~/Velaria uncommitted changes' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{
      type: 'toolCall',
      id: 'coder-exec-call',
      name: 'exec',
      arguments: {
        command: "cd ~/Velaria && git status --short && sed -n '1,200p' src/dataflow/core/logical/planner/plan.h",
        workdir: '/Users/bytedance/.openclaw/workspace-coder',
      },
    }],
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'coder-exec-call',
    toolName: 'exec',
    content: [{ type: 'text', text: 'M src/dataflow/core/logical/planner/plan.h' }],
    details: {
      status: 'completed',
      aggregated: "M src/dataflow/core/logical/planner/plan.h\nM src/dataflow/core/execution/runtime/execution_optimizer.cc",
      cwd: '/Users/bytedance/.openclaw/workspace-coder',
    },
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Analysis complete, there are 4 key blocks.' }],
    timestamp: Date.now(),
  },
];

const longRunPrompt = 'Inspect the workspace and summarize the result';
const longRunProcessSegments = Array.from({ length: 9 }, (_, index) => `Checked source ${index + 1}.`);
const longRunSummary = 'Here is the summary.';
const longRunReplyText = `${longRunProcessSegments.join(' ')} ${longRunSummary}`;
const longRunHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: longRunPrompt }],
    timestamp: Date.now(),
  },
  ...longRunProcessSegments.map((segment, index) => ({
    role: 'assistant',
    id: `long-run-step-${index + 1}`,
    content: [{ type: 'text', text: segment }],
    timestamp: Date.now(),
  })),
  {
    role: 'assistant',
    id: 'long-run-final',
    content: [{ type: 'text', text: longRunReplyText }],
    timestamp: Date.now(),
  },
];

const errorRunPrompt = '你是什么模型？';
const thinkingProcessPrompt = 'Summarize important messages';
const thinkingProcessNarration = 'I checked the source messages and grouped the important items.';
const thinkingProcessSummary = 'Here are the important items.';
const thinkingProcessReplyText = `${thinkingProcessNarration} ${thinkingProcessSummary}`;
const thinkingProcessHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: thinkingProcessPrompt }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'thinking-process-step',
    content: [
      { type: 'thinking', thinking: thinkingProcessNarration },
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'messages.json' } },
    ],
    stopReason: 'toolUse',
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'read-1',
    toolName: 'read',
    content: [{ type: 'text', text: 'messages' }],
    isError: false,
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'thinking-process-final',
    content: [{ type: 'text', text: thinkingProcessReplyText }],
    stopReason: 'stop',
    timestamp: Date.now(),
  },
];

const printerWaitFinalText = [
  '默认打印机是 "Microsoft Print to PDF"（虚拟打印机，生成 PDF 文件），不是物理打印机。',
  '这解释了为什么等待队列超时 - Microsoft Print to PDF 需要用户交互来选择保存位置。',
  '**问题**：您的默认打印机是 Microsoft Print to PDF（虚拟打印机），它会将文件打印成 PDF 而不是在实际打印机上输出。',
  '文件夹中还包含 .docx 和 .pptx 文件。',
].join('\n\n');
const printerWaitHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: '打印文件夹中的所有文件' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: '正在打印第一个 Word 文件，再等一会看进度。' },
      { type: 'toolCall', id: 'wait-print', name: 'process', arguments: { action: 'poll' } },
    ],
    stopReason: 'toolUse',
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'wait-print',
    toolName: 'process',
    content: [{ type: 'text', text: 'timed out' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'printer-wait-final',
    content: [{ type: 'text', text: printerWaitFinalText }],
    stopReason: 'stop',
    timestamp: Date.now(),
  },
];

const meetingSummaryFinalText = [
  '# AI Coding 范式会议纪要',
  '## SuperPower 核心技能体系',
  '- **SDD**：将大任务拆分为多个子 Agent 协同完成',
  '- **完成后验证**：检查是否按计划执行，进行回归测试与代码评审请求',
  '## 会议结论',
  '团队将逐步建立每个需求必有 spec 的开发文化。',
].join('\n\n');
const meetingSummaryHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: '整理会议纪要' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'meeting-read', name: 'read', arguments: { path: 'meeting.txt' } }],
    stopReason: 'toolUse',
    timestamp: Date.now(),
  },
  {
    role: 'toolResult',
    toolCallId: 'meeting-read',
    toolName: 'read',
    content: [{ type: 'text', text: '会议原文' }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'meeting-summary-final',
    content: [{ type: 'text', text: meetingSummaryFinalText }],
    stopReason: 'stop',
    timestamp: Date.now(),
  },
];

const errorRunHistory = [
  {
    role: 'user',
    content: [{ type: 'text', text: errorRunPrompt }],
    timestamp: Date.now(),
  },
  {
    role: 'assistant',
    id: 'error-final',
    content: [],
    stopReason: 'error',
    errorMessage: '404 Resource not found',
    timestamp: Date.now(),
  },
];

test.describe('ClawX chat execution graph', () => {
  test('shows subagent orchestration steps while flattening child tool work into the parent run', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: seededHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: {
              messages: seededHistory,
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [
                  { id: 'main', name: 'main' },
                  { id: 'coder', name: 'coder' },
                ],
              },
            },
          },
          [stableStringify([`/api/sessions/transcript?agentId=coder&sessionId=${CODER_SESSION_ID}`, 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                messages: childTranscriptMessages,
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }
      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).toBeVisible({ timeout: 30_000 });
      // Completed runs auto-collapse into a single-line summary button. Expand
      // it first so the underlying step details are rendered.
      const graph = page.getByTestId('chat-execution-graph');
      if ((await graph.getAttribute('data-collapsed')) === 'true') {
        await graph.click();
      }
      await expect(
        page.locator('[data-testid="chat-execution-graph"] [data-testid="chat-execution-step"]').getByText('sessions_spawn', { exact: true }),
      ).toHaveCount(0);
      await expect(page.getByText('[Internal task completion event]')).toHaveCount(0);
      await expect(
        page.locator('[data-testid="chat-execution-graph"] [data-testid="chat-execution-step"]').getByText('exec', { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator('[data-testid="chat-execution-graph"] [data-testid="chat-execution-step"]').getByText(/coder run/i),
      ).toBeVisible();
      await expect(page.getByText('Coder has finished the analysis, here are the conclusions.')).toBeVisible();
      await expect(page.getByText('CHECKLIST.md')).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-step-thinking-trailing')).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('preserves long execution history counts and strips the full folded reply prefix', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: longRunHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: {
              messages: longRunHistory,
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('chat-execution-graph')).toHaveAttribute('data-collapsed', 'true');
      await expect(page.getByTestId('chat-execution-graph')).toContainText('0 tool calls');
      await expect(page.getByTestId('chat-execution-graph')).toContainText('9 process messages');
      await expect(page.getByText(longRunSummary, { exact: true })).toBeVisible();
      await expect(page.getByText(longRunReplyText, { exact: true })).toHaveCount(0);
    } finally {
      await closeElectronApp(app);
    }
  });

  test('strips thinking-classified process text from the final reply bubble', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: thinkingProcessHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: {
              messages: thinkingProcessHistory,
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(thinkingProcessSummary, { exact: true })).toBeVisible();
      await expect(page.getByText(thinkingProcessReplyText, { exact: true })).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-graph')).toContainText('1 process message');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps a terminal printer diagnosis out of the graph when it mentions waiting and PPTX', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: printerWaitHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: {
              messages: printerWaitHistory,
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-message-3')).toContainText('默认打印机是 "Microsoft Print to PDF"', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('chat-execution-graph')).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).not.toContainText('这解释了为什么等待队列超时');
      await expect(page.getByTestId('chat-execution-graph')).toContainText('1 process message');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps a terminal meeting summary visible when it mentions sub-agent execution', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: meetingSummaryHistory },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: { messages: meetingSummaryHistory },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByTestId('chat-message-3')).toContainText('AI Coding 范式会议纪要', {
        timeout: 30_000,
      });
      await expect(page.getByTestId('chat-execution-graph')).toBeVisible();
      await expect(page.getByTestId('chat-execution-graph')).not.toContainText('AI Coding 范式会议纪要');
    } finally {
      await closeElectronApp(app);
    }
  });

  test('surfaces terminal model errors and stops the stale thinking state', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });

    try {
      await installIpcMocks(app, {
        gatewayStatus: { state: 'running', port: 18789, pid: 12345 },
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: {
              sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }],
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: {
              messages: errorRunHistory,
            },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: {
              messages: errorRunHistory,
            },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { state: 'running', port: 18789, pid: 12345 },
            },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: {
                success: true,
                agents: [{ id: 'main', name: 'main' }],
              },
            },
          },
        },
      });

      const page = await getStableWindow(app);
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) {
          throw error;
        }
      }

      await expect(page.getByTestId('main-layout')).toBeVisible();
      await expect(page.getByText('404 Resource not found')).toBeVisible({ timeout: 30_000 });
      const runErrorCallout = page.getByTestId('chat-run-error');
      await expect(runErrorCallout).toBeVisible({ timeout: 30_000 });
      await expect(runErrorCallout).toContainText('404 Resource not found');
      await expect(page.getByTestId('chat-execution-graph')).toHaveCount(0);
      await expect(page.getByTestId('chat-execution-step-thinking-trailing')).toHaveCount(0);
      await expect(page.getByText('404 Resource not found')).toHaveCount(1);
      await page.getByTestId('chat-composer-input').fill('retry');
      await expect(page.getByTestId('chat-composer-send')).toBeEnabled();
    } finally {
      await closeElectronApp(app);
    }
  });

  test('keeps a cumulative final with a settled stale tool call outside the execution graph', async ({ launchElectronApp }) => {
    const app = await launchElectronApp({ skipSetup: true });
    const narration = 'I will gather the latest intelligence first.';
    const finalReply = "Kimi model activity is included in today's summary.";
    const history = [
      { role: 'user', content: 'Generate LY intelligence', timestamp: Date.now() },
      {
        role: 'assistant',
        id: 'settled-tool-round',
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: narration },
          { type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        ],
        timestamp: Date.now() + 1,
      },
      { role: 'toolResult', toolCallId: 'fetch-1', content: 'source fetched', timestamp: Date.now() + 2 },
      {
        role: 'assistant',
        id: 'authoritative-cumulative-final',
        stopReason: 'stop',
        content: [
          { type: 'text', text: `${narration} ${finalReply}` },
          { type: 'toolCall', id: 'fetch-1', name: 'web_fetch', arguments: { url: 'https://example.com' } },
        ],
        timestamp: Date.now() + 3,
      },
    ];

    try {
      const gatewayStatus = { state: 'running', port: 18789, pid: 12345 };
      await installIpcMocks(app, {
        gatewayStatus,
        gatewayRpc: {
          [stableStringify(['sessions.list', {}])]: {
            success: true,
            result: { sessions: [{ key: PROJECT_MANAGER_SESSION_KEY, displayName: 'main' }] },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 200 }])]: {
            success: true,
            result: { messages: history },
          },
          [stableStringify(['chat.history', { sessionKey: PROJECT_MANAGER_SESSION_KEY, limit: 1000 }])]: {
            success: true,
            result: { messages: history },
          },
        },
        hostApi: {
          [stableStringify(['/api/gateway/status', 'GET'])]: {
            ok: true,
            data: { status: 200, ok: true, json: gatewayStatus },
          },
          [stableStringify(['/api/agents', 'GET'])]: {
            ok: true,
            data: {
              status: 200,
              ok: true,
              json: { success: true, agents: [{ id: 'main', name: 'main' }] },
            },
          },
        },
      });

      const page = await app.firstWindow();
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 });
      try {
        await page.reload();
      } catch (error) {
        if (!String(error).includes('ERR_FILE_NOT_FOUND')) throw error;
      }

      await expect(page.getByText(finalReply, { exact: true })).toBeVisible({ timeout: 30_000 });
      const graph = page.getByTestId('chat-execution-graph');
      await expect(graph).toBeVisible();
      if ((await graph.getAttribute('data-collapsed')) === 'true') await graph.click();
      await expect(graph).not.toContainText(finalReply);
      await expect(graph).toContainText(narration);
    } finally {
      await closeElectronApp(app);
    }
  });
});
