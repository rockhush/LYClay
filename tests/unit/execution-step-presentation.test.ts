import { beforeAll, describe, expect, it } from 'vitest';
import i18n from 'i18next';
import zhChat from '@/i18n/locales/zh/chat.json';
import enChat from '@/i18n/locales/en/chat.json';
import {
  isNonBlockingToolFailureStep,
  isNonActionableRunEnabledStep,
  resolveExecutionStepPresentation,
} from '@/pages/Chat/execution-step-presentation';
import { deriveTaskSteps, type TaskStep } from '@/pages/Chat/task-visualization';
import type { ToolStatus } from '@/stores/chat';

beforeAll(async () => {
  await i18n.init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: {
      zh: { chat: zhChat },
      en: { chat: enChat },
    },
  });
});

function errorStep(label: string, detail = 'raw internal error'): TaskStep {
  return {
    id: label,
    label,
    detail,
    status: 'error',
    kind: 'tool',
    depth: 1,
  };
}

describe('resolveExecutionStepPresentation', () => {
  it.each([
    ['Cron', '定时任务操作失败', '检查任务配置'],
    ['Update Goal: complete', '目标状态更新失败', '不会撤销'],
    ['Nodes: gateway', '设备节点操作失败', '已配对'],
    ['Message', '消息发送失败', '接收人'],
    ['skill_workshop', '技能处理失败', '技能内容'],
    ['canvas', '画布操作失败', '普通文本'],
    ['browser', '浏览器操作失败', '刷新页面'],
    ['cmd /c python', '命令执行失败', '运行环境'],
    ['Response', '回复生成失败', '切换模型'],
  ])('maps %s failures to Chinese guidance', (label, title, guidance) => {
    const presentation = resolveExecutionStepPresentation(
      errorStep(label),
      i18n.getFixedT('zh', 'chat'),
    );

    expect(presentation.label).toBe(title);
    expect(presentation.detail).toContain(guidance);
    expect(presentation.detail).not.toContain('raw internal error');
  });

  it('leaves unrelated tool steps unchanged', () => {
    const step = errorStep('write', 'permission denied');
    expect(resolveExecutionStepPresentation(step, i18n.getFixedT('zh', 'chat'))).toEqual({
      label: 'write',
      detail: 'permission denied',
    });
  });
});

describe('isNonActionableRunEnabledStep', () => {
  it('hides only completed Run Enabled status rows', () => {
    expect(isNonActionableRunEnabledStep({
      id: 'run-enabled',
      label: 'Run',
      detail: 'Enabled',
      status: 'completed',
      kind: 'system',
      depth: 2,
    })).toBe(true);

    expect(isNonActionableRunEnabledStep({
      id: 'run-failed',
      label: 'Run Enabled',
      status: 'error',
      kind: 'system',
      depth: 2,
    })).toBe(false);
  });

  it('removes completed Run Enabled rows from derived execution steps', () => {
    const streamingTools: ToolStatus[] = [{
      id: 'run-enabled',
      name: 'Run',
      summary: 'Enabled',
      status: 'completed',
      updatedAt: Date.now(),
    }];

    expect(deriveTaskSteps({
      messages: [],
      streamingMessage: null,
      streamingTools,
      includeHiddenToolSteps: true,
    })).toEqual([]);
  });
});

describe('non-blocking tool failure visibility', () => {
  const failureNames = ['Write', 'Nodes', 'Apply Patch', 'Message', 'Cron', 'Exec', 'Canvas'];

  it.each(failureNames)('recognizes %s failures as suppressible tool noise', (label) => {
    expect(isNonBlockingToolFailureStep(errorStep(label))).toBe(true);
  });

  it.each(failureNames)('recognizes "%s failed" narration rows', (name) => {
    expect(isNonBlockingToolFailureStep({
      id: name,
      label: 'Message',
      detail: `${name} failed`,
      status: 'completed',
      kind: 'message',
      depth: 1,
    })).toBe(true);
  });

  it('hides listed tool failures after an explicit successful result', () => {
    const streamingTools: ToolStatus[] = failureNames.map((name, index) => ({
      id: `failed-tool-${index}`,
      name,
      summary: `${name} failed`,
      status: 'error',
      updatedAt: Date.now(),
    }));

    const steps = deriveTaskSteps({
      messages: [{
        role: 'assistant',
        content: 'The requested result was completed successfully.',
        stopReason: 'stop',
      }],
      streamingMessage: null,
      streamingTools,
      includeHiddenToolSteps: true,
    });

    expect(steps).toEqual([]);
  });

  it('keeps listed tool failures when the run did not produce a successful result', () => {
    const streamingTools: ToolStatus[] = [{
      id: 'failed-write',
      name: 'Write',
      summary: 'Write failed',
      status: 'error',
      updatedAt: Date.now(),
    }];

    const steps = deriveTaskSteps({
      messages: [{
        role: 'assistant',
        content: 'The run failed before the requested result was produced.',
        stopReason: 'error',
      }],
      streamingMessage: null,
      streamingTools,
      includeHiddenToolSteps: true,
    });

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'failed-write',
        status: 'error',
      }),
    ]);
  });
});
