import { describe, expect, it } from 'vitest';
import {
  inferTranscriptSettledChildSessionKeys,
  resolveCompletedChildSessionKeys,
  isInterimSubagentWaitAssistantReply,
} from '@/lib/subagent-delegation';
import {
  isDelegationWrapUpComplete,
  isSegmentDelegationPhaseOpen,
} from '@/lib/delegation-turn-state';
import type { RawMessage } from '@/stores/chat/types';

const CHILD = 'agent:main:subagent:ad529cd1-3257-428d-802f-28eb7fdb9ebb';
const PARENT = 'agent:main:session-1782989164284';

function cad82Messages(): RawMessage[] {
  return [
    { role: 'user', content: 'make ppt', timestamp: 1000 },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: {} }],
      stopReason: 'toolUse',
    },
    { role: 'toolResult', toolCallId: 'read-1', content: [{ type: 'text', text: 'skill' }] },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'ppt' } }],
      stopReason: 'toolUse',
    },
    {
      role: 'toolResult',
      toolCallId: 'spawn-1',
      content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: CHILD }) }],
    },
    {
      role: 'assistant',
      content: '子 Agent 已启动，正在并行构建 PPT。完成后我会通知你。预计需要几分钟。',
      stopReason: 'stop',
      timestamp: 3000,
    },
    {
      role: 'assistant',
      content: 'PPT 已生成完毕 ✅\n\n文件保存在：**`LYClaw_数字员工体系.pptx`**（15 页）',
      stopReason: 'stop',
      timestamp: 5000,
    },
  ];
}

const CHILD_6F69 = 'agent:main:subagent:45930a6e-da28-4b42-8f62-6fa5a3064b56';
const PARENT_6F69 = 'agent:main:session-1782990100880';

function session6f69Messages(): RawMessage[] {
  return [
    { role: 'user', content: 'generate ppt via sub-agent', timestamp: 1000 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: "I'll spawn a sub-agent to generate this PPTX presentation." }],
      stopReason: 'toolUse',
    },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'digital-employee-pptx' } }],
      stopReason: 'toolUse',
    },
    {
      role: 'toolResult',
      toolCallId: 'spawn-1',
      content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: CHILD_6F69 }) }],
    },
    {
      role: 'assistant',
      content: 'PPT 正在由子智能体生成中，预计几分钟内完成。完成后会自动通知你。',
      stopReason: 'stop',
      timestamp: 3000,
    },
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'exec-1', name: 'exec', input: { command: 'check' } }],
      stopReason: 'toolUse',
      timestamp: 4000,
    },
    { role: 'toolResult', toolCallId: 'exec-1', content: [{ type: 'text', text: 'Size: 579 KB' }] },
    {
      role: 'assistant',
      content: '已经为你打开了 PPTX 文件。以下是成品概况：\n\n## 数字员工建设方案.pptx — 15 页完成',
      stopReason: 'stop',
      timestamp: 5000,
    },
  ];
}

describe('subagent-delegation transcript settle inference', () => {
  it('infers settled child keys from announce wrap-up without runtime announce state', () => {
    const messages = cad82Messages();
    const inferred = inferTranscriptSettledChildSessionKeys(messages);
    expect([...inferred]).toEqual([CHILD]);
  });

  it('does not infer settle while only the interim wait reply exists', () => {
    const messages = cad82Messages().slice(0, -1);
    expect(inferTranscriptSettledChildSessionKeys(messages).size).toBe(0);
  });

  it('classifies 子代理 interim wait replies', () => {
    expect(isInterimSubagentWaitAssistantReply({
      role: 'assistant',
      content: 'PPT 正在由子代理生成中，包含 15 页完整内容，橙色主题 + 纯白背景。完成后我会通知你。',
      stopReason: 'toolUse',
    })).toBe(true);
  });

  it('classifies partial multi-phase progress as interim wait, not final delivery', () => {
    expect(isInterimSubagentWaitAssistantReply({
      role: 'assistant',
      content: 'Phase 1（slides 1-5）也完成了！✅ 继续等待 Phase 3（slides 11-15）～',
      stopReason: 'stop',
    })).toBe(true);
    expect(isInterimSubagentWaitAssistantReply({
      role: 'assistant',
      content: 'Phase 2 和 Phase 3 已完成，继续等待 Phase 1（slides 1-5）～',
      stopReason: 'stop',
    })).toBe(true);
  });

  it('closes delegation UI gates from transcript inference alone', () => {
    const messages = cad82Messages();
    const segment = messages.slice(1);
    const staleProcessing = [PARENT, CHILD];
    const completed = resolveCompletedChildSessionKeys(messages);

    expect(isSegmentDelegationPhaseOpen(segment, staleProcessing, { completedChildSessionKeys: completed })).toBe(false);
    expect(isDelegationWrapUpComplete(messages, staleProcessing, {
      lastUserMessageAt: 1000,
      completedChildSessionKeys: completed,
    })).toBe(true);
  });

  it('infers settle for inline announce exec wrap-up (session 6f69 shape)', () => {
    const messages = session6f69Messages();
    const staleProcessing = [PARENT_6F69, CHILD_6F69];
    const completed = resolveCompletedChildSessionKeys(messages);
    const segment = messages.slice(1);

    expect([...inferTranscriptSettledChildSessionKeys(messages)]).toEqual([CHILD_6F69]);
    expect(isSegmentDelegationPhaseOpen(segment, staleProcessing, { completedChildSessionKeys: completed })).toBe(false);
    expect(isDelegationWrapUpComplete(messages, staleProcessing, {
      lastUserMessageAt: 1000,
      completedChildSessionKeys: completed,
    })).toBe(true);
  });

  it('infers settle for sessions_yield + announce wrap-up (session 27676084 shape)', () => {
    const CHILD = 'agent:main:subagent:49424d13-c3a3-4a4c-b9d5-5b1182bcd972';
    const PARENT = 'agent:main:session-1782991299226';
    const messages: RawMessage[] = [
      { role: 'user', content: 'make ppt', timestamp: 1000 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'spawn-1', name: 'sessions_spawn', input: { taskName: 'lyclaw-pptx-build' } }],
      },
      {
        role: 'toolResult',
        toolCallId: 'spawn-1',
        content: [{ type: 'text', text: JSON.stringify({ status: 'accepted', childSessionKey: CHILD }) }],
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'PPT 正在由子代理生成中，包含 15 页完整内容，橙色主题 + 纯白背景。完成后我会通知你。' },
          { type: 'toolCall', id: 'yield-1', name: 'sessions_yield', arguments: {} },
        ],
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolCallId: 'yield-1',
        content: [{ type: 'text', text: JSON.stringify({ status: 'yielded' }) }],
      },
      {
        role: 'assistant',
        content: '✅ **PPT 已生成完毕！**\n\n📁 **文件：** `LYClaw_Digital_Employee.pptx` (548 KB)',
        stopReason: 'stop',
        timestamp: 5000,
      },
    ];
    const completed = resolveCompletedChildSessionKeys(messages);
    const staleProcessing = [PARENT, CHILD];

    expect([...inferTranscriptSettledChildSessionKeys(messages)]).toEqual([CHILD]);
    expect(isDelegationWrapUpComplete(messages, staleProcessing, {
      lastUserMessageAt: 1000,
      completedChildSessionKeys: completed,
    })).toBe(true);
    expect(isSegmentDelegationPhaseOpen(messages.slice(1), staleProcessing, {
      completedChildSessionKeys: completed,
    })).toBe(false);
  });
});
