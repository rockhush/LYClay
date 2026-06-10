import { beforeAll, describe, expect, it } from 'vitest';
import i18n from 'i18next';
import zhCron from '@/i18n/locales/zh/cron.json';
import enCron from '@/i18n/locales/en/cron.json';
import { translateCronError } from '@/lib/cron-error-i18n';

beforeAll(async () => {
  await i18n.init({
    lng: 'zh',
    fallbackLng: 'en',
    resources: {
      zh: { cron: zhCron },
      en: { cron: enCron },
    },
  });
});

describe('translateCronError', () => {
  it('translates cron-prefixed isolated agent timeout errors', () => {
    const t = i18n.getFixedT('zh', 'cron');
    expect(
      translateCronError('cron: isolated agent setup timed out before runner start', t),
    ).toBe('隔离智能体在运行器启动前初始化超时');
  });

  it('translates run failed wrapper errors', () => {
    const t = i18n.getFixedT('zh', 'cron');
    expect(
      translateCronError('Run failed: Channel is required', t),
    ).toBe('需要配置消息通道');
  });

  it('translates channel required errors', () => {
    const t = i18n.getFixedT('zh', 'cron');
    expect(translateCronError('Channel is required', t)).toBe('需要配置消息通道');
  });

  it('falls back to a Chinese wrapper for unknown errors', () => {
    const t = i18n.getFixedT('zh', 'cron');
    expect(translateCronError('some unexpected backend error', t)).toBe(
      '定时任务出错：some unexpected backend error',
    );
  });
});
