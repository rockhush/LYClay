import { beforeAll, describe, expect, it } from 'vitest';
import i18n from 'i18next';
import zhChat from '@/i18n/locales/zh/chat.json';
import enChat from '@/i18n/locales/en/chat.json';
import {
  resolveEmbeddedAgentFailureMessage,
  resolveChatRunErrorPresentation,
  resolveEmptyFinalRecoveryMessage,
} from '@/stores/chat/error-presentation';

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

describe('resolveChatRunErrorPresentation', () => {
  it('maps a repeated malformed tool-call stream failure to retry guidance', () => {
    const t = i18n.getFixedT('zh', 'chat');
    const raw = 'list index out of range';

    const presentation = resolveChatRunErrorPresentation(raw, t);

    expect(presentation.title).toBe('执行失败');
    expect(presentation.detail).toContain('工具调用格式异常');
    expect(presentation.detail).toContain('重试');
    expect(presentation.detail).toContain('新建会话');
    expect(raw).toBe('list index out of range');
  });

  it('maps an idle model timeout without exposing the raw runtime marker', () => {
    const t = i18n.getFixedT('zh', 'chat');
    const presentation = resolveChatRunErrorPresentation('LLM idle timeout after 300000ms', t);

    expect(presentation.title).toBe('大模型响应超时');
    expect(presentation.detail).toContain('自动结束');
    expect(presentation.detail).toContain('稍后重试');
    expect(presentation.detail).not.toContain('LLM idle timeout');
  });

  it('maps an agent request timeout to model retry guidance', () => {
    const t = i18n.getFixedT('zh', 'chat');
    const presentation = resolveChatRunErrorPresentation(
      'Agent failed before reply: LLM request timed out. Logs: openclaw logs --follow',
      t,
    );

    expect(presentation.title).toBe('大模型响应超时');
    expect(presentation.detail).toContain('切换模型');
    expect(presentation.detail).not.toContain('openclaw logs');
  });

  it('maps an isolated cron setup stall without exposing its runtime phase', () => {
    const t = i18n.getFixedT('zh', 'chat');
    const presentation = resolveChatRunErrorPresentation(
      'aborted | cron: isolated agent run stalled before execution start (last phase: context-engine)',
      t,
    );

    expect(presentation.title).toBe('智能体启动超时');
    expect(presentation.detail).toContain('准备上下文');
    expect(presentation.detail).toContain('重启应用');
    expect(presentation.detail).not.toContain('context-engine');
  });

  it('maps a rejected provider payload to compatibility guidance', () => {
    const t = i18n.getFixedT('zh', 'chat');
    const presentation = resolveChatRunErrorPresentation(
      'LLM request failed: provider rejected the request schema or tool payload.',
      t,
    );

    expect(presentation.title).toBe('模型请求格式不兼容');
    expect(presentation.detail).toContain('切换模型');
    expect(presentation.detail).not.toContain('schema');
  });

  it.each([
    [
      "Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
      '回复生成失败',
      '确认实际结果',
    ],
    [
      'Run interrupted because the Gateway restarted.',
      '运行已中断',
      '恢复连接',
    ],
    [
      'OutboundDeliveryError: Request failed with status code 400',
      '消息投递失败',
      '接收人',
    ],
    [
      'cmd /c python "~\\.openclaw\\workspace\\read_xlsx_zip.py" failed',
      '命令执行失败',
      '运行环境',
    ],
    [
      'Run Ended',
      '运行已结束',
      '手动重试',
    ],
  ])('maps additional operational error "%s"', (raw, title, guidance) => {
    const presentation = resolveChatRunErrorPresentation(raw, i18n.getFixedT('zh', 'chat'));

    expect(presentation.title).toBe(title);
    expect(presentation.detail).toContain(guidance);
    expect(presentation.detail).not.toContain(raw);
  });

  it('localizes an embedded agent no-response notice for display', () => {
    const raw = "Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.";
    const display = resolveEmbeddedAgentFailureMessage(raw, i18n.getFixedT('zh', 'chat'));

    expect(display).toContain('智能体未能生成回复');
    expect(display).toContain('确认实际结果');
    expect(display).not.toContain('Agent');
  });

  it('maps an outbound media path failure without exposing the local path', () => {
    const t = i18n.getFixedT('zh', 'chat');
    const raw = 'C:\\Users\\demo\\.openclaw\\media\\outbound\\abc-photo.jpg failed';
    const presentation = resolveChatRunErrorPresentation(raw, t);

    expect(presentation.title).toBe('附件发送失败');
    expect(presentation.detail).toContain('重新上传');
    expect(presentation.detail).not.toContain('C:\\Users\\demo');
  });

  it.each([
    'ENOENT: no such file or directory, open C:\\Users\\private-user\\.openclaw\\state.json',
    'EACCES: permission denied, open /home/private-user/.openclaw/state.json',
    'Failed to read /Users/private-user/.openclaw/state.json',
  ])('redacts local user paths from otherwise unknown errors: %s', (raw) => {
    const t = i18n.getFixedT('zh', 'chat');
    const presentation = resolveChatRunErrorPresentation(raw, t);

    expect(presentation?.detail).not.toContain('private-user');
    expect(presentation?.detail).toContain('本地路径已隐藏');
  });
});

describe('resolveEmptyFinalRecoveryMessage', () => {
  it('provides localized actions for every user-visible recovery state', () => {
    const t = i18n.getFixedT('zh', 'chat');

    expect(resolveEmptyFinalRecoveryMessage('waiting', t)).toContain('停止当前运行或新建会话');
    expect(resolveEmptyFinalRecoveryMessage('stale', t)).toContain('恢复会话');
    expect(resolveEmptyFinalRecoveryMessage('recovered', t)).toContain('手动重试');
    expect(resolveEmptyFinalRecoveryMessage('failed', t)).toContain('新建会话');
    expect(resolveEmptyFinalRecoveryMessage('recovering', t)).toContain('正在恢复');
  });
});
