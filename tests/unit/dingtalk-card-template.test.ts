import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@electron/utils/dingtalk-oauth', () => ({
  getLyclawEnvVariable: vi.fn(() => ''),
}));

import { getLyclawEnvVariable } from '@electron/utils/dingtalk-oauth';
import {
  DEFAULT_DINGTALK_CARD_TEMPLATE_ID,
  LEGACY_DINGTALK_CARD_TEMPLATE_IDS,
  applyDingTalkCardTemplateDefaults,
  normalizeStoredDingTalkCardTemplateId,
  resolveActiveDingTalkCardTemplateId,
  resolveDingTalkCardTemplateGatewayEnv,
} from '@electron/utils/dingtalk-card-template';
import type { OpenClawConfig } from '@electron/utils/channel-config';

describe('dingtalk-card-template', () => {
  beforeEach(() => {
    vi.mocked(getLyclawEnvVariable).mockReturnValue('');
    delete process.env.DINGTALK_CARD_TEMPLATE_ID;
  });

  it('applies card mode and default template id to dingtalk section', () => {
    const section: Record<string, unknown> = {
      enabled: true,
      accounts: {
        default: {
          clientId: 'ding-app',
          clientSecret: 'secret',
        },
      },
    };

    applyDingTalkCardTemplateDefaults(section);

    expect(section.messageType).toBe('card');
    expect(section.cardTemplateId).toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
    expect(section.cardStatusLine).toEqual({
      model: false,
      effort: false,
      agent: false,
      taskTime: false,
      tokens: false,
      dapiUsage: false,
    });
    expect((section.accounts as Record<string, Record<string, unknown>>).default.messageType).toBe('card');
    expect((section.accounts as Record<string, Record<string, unknown>>).default.cardTemplateId)
      .toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
    expect((section.accounts as Record<string, Record<string, unknown>>).default.cardStatusLine).toEqual(
      section.cardStatusLine,
    );
  });

  it('preserves explicit cardTemplateId values', () => {
    const section: Record<string, unknown> = {
      messageType: 'markdown',
      cardTemplateId: 'custom-template.schema',
      accounts: {
        default: {
          cardTemplateId: 'custom-template.schema',
        },
      },
    };

    applyDingTalkCardTemplateDefaults(section);

    expect(section.messageType).toBe('markdown');
    expect(section.cardTemplateId).toBe('custom-template.schema');
  });

  it('migrates previous LYClaw default template ids', () => {
    for (const legacyId of LEGACY_DINGTALK_CARD_TEMPLATE_IDS) {
      expect(normalizeStoredDingTalkCardTemplateId(legacyId))
        .toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
    }

    const section: Record<string, unknown> = {
      cardTemplateId: LEGACY_DINGTALK_CARD_TEMPLATE_IDS[1],
    };
    applyDingTalkCardTemplateDefaults(section);
    expect(section.cardTemplateId).toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
  });

  it('resolves gateway env from default dingtalk account template', () => {
    const config: OpenClawConfig = {
      channels: {
        dingtalk: {
          enabled: true,
          defaultAccount: 'bot-a',
          cardTemplateId: 'ignored-top-level.schema',
          accounts: {
            'bot-a': {
              clientId: 'ding-a',
              cardTemplateId: DEFAULT_DINGTALK_CARD_TEMPLATE_ID,
            },
          },
        },
      },
    };

    expect(resolveDingTalkCardTemplateGatewayEnv(config)).toEqual({
      DINGTALK_CARD_TEMPLATE_ID: DEFAULT_DINGTALK_CARD_TEMPLATE_ID,
    });
  });

  it('syncs all dingtalk accounts to the unified channel cardTemplateId', () => {
    const section: Record<string, unknown> = {
      cardTemplateId: DEFAULT_DINGTALK_CARD_TEMPLATE_ID,
      accounts: {
        default: {
          clientId: 'ding-a',
          cardTemplateId: LEGACY_DINGTALK_CARD_TEMPLATE_IDS[0],
        },
        bot_b: {
          clientId: 'ding-b',
        },
        bot_c: {
          clientId: 'ding-c',
          cardTemplateId: 'other-template.schema',
        },
      },
    };

    applyDingTalkCardTemplateDefaults(section);

    const accounts = section.accounts as Record<string, Record<string, unknown>>;
    expect(accounts.default.cardTemplateId).toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
    expect(accounts.bot_b.cardTemplateId).toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
    expect(accounts.bot_c.cardTemplateId).toBe(DEFAULT_DINGTALK_CARD_TEMPLATE_ID);
  });

  it('prefers LYCLAW env override when resolving active template id', () => {
    vi.mocked(getLyclawEnvVariable).mockReturnValue('env-template.schema');

    expect(resolveActiveDingTalkCardTemplateId({
      channels: {
        dingtalk: {
          cardTemplateId: DEFAULT_DINGTALK_CARD_TEMPLATE_ID,
        },
      },
    })).toBe('env-template.schema');
  });
});
