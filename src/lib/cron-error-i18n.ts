import type { TFunction } from 'i18next';

function stripCronErrorPrefixes(error: string): string {
  let message = error.trim();

  for (;;) {
    const runFailed = message.match(/^run failed:\s*(.+)$/i);
    if (runFailed) {
      message = runFailed[1].trim();
      continue;
    }

    const cronPrefix = message.match(/^cron:\s*(.+)$/i);
    if (cronPrefix) {
      message = cronPrefix[1].trim();
      continue;
    }

    break;
  }

  return message;
}

type CronErrorMatcher = {
  test: (message: string) => boolean;
  key: `errors.${string}`;
  detail?: (message: string) => string | undefined;
};

const CRON_ERROR_MATCHERS: CronErrorMatcher[] = [
  {
    test: (message) => /^isolated agent setup timed out before runner start$/i.test(message),
    key: 'errors.isolatedAgentSetupTimeout',
  },
  {
    test: (message) => /^job interrupted by gateway restart\.?$/i.test(message),
    key: 'errors.jobInterruptedByGatewayRestart',
  },
  {
    test: (message) => /^channel is required\.?$/i.test(message),
    key: 'errors.channelRequired',
  },
  {
    test: (message) => /^scheduled task failed\.?$/i.test(message),
    key: 'errors.scheduledTaskFailed',
  },
  {
    test: (message) => /^runner start failed(?:\s*:\s*(.+))?$/i.test(message),
    key: 'errors.runnerStartFailed',
    detail: (message) => message.match(/^runner start failed(?:\s*:\s*(.+))?$/i)?.[1]?.trim() || undefined,
  },
  {
    test: (message) => /^agent turn failed(?:\s*:\s*(.+))?$/i.test(message),
    key: 'errors.agentTurnFailed',
    detail: (message) => message.match(/^agent turn failed(?:\s*:\s*(.+))?$/i)?.[1]?.trim() || undefined,
  },
  {
    test: (message) => /^delivery failed(?:\s*:\s*(.+))?$/i.test(message),
    key: 'errors.deliveryFailed',
    detail: (message) => message.match(/^delivery failed(?:\s*:\s*(.+))?$/i)?.[1]?.trim() || undefined,
  },
  {
    test: (message) => /^job is disabled\.?$/i.test(message),
    key: 'errors.jobDisabled',
  },
  {
    test: (message) => /gateway.*(?:not running|unavailable|disconnected)/i.test(message),
    key: 'errors.gatewayUnavailable',
  },
  {
    test: (message) => /(?:rpc|request).*timed out/i.test(message),
    key: 'errors.requestTimeout',
  },
  {
    test: (message) => /^agent\s+["']?([^"']+)["']?\s+not found\.?$/i.test(message),
    key: 'errors.agentNotFound',
    detail: (message) => message.match(/^agent\s+["']?([^"']+)["']?\s+not found\.?$/i)?.[1]?.trim(),
  },
  {
    test: (message) => /no (?:default )?model/i.test(message),
    key: 'errors.noModelConfigured',
  },
  {
    test: (message) => /econnrefused|enotfound|network error|fetch failed/i.test(message),
    key: 'errors.network',
  },
  {
    test: (message) => /invalid cron|invalid schedule/i.test(message),
    key: 'errors.invalidSchedule',
  },
  {
    test: (message) => /timed out/i.test(message),
    key: 'errors.timeout',
    detail: (message) => message,
  },
  {
    test: (message) => /failed/i.test(message),
    key: 'errors.genericFailed',
    detail: (message) => message,
  },
];

export function translateCronError(
  error: string | undefined | null,
  t: TFunction<'cron'>,
): string {
  if (!error?.trim()) return '';

  const normalized = stripCronErrorPrefixes(error);
  for (const matcher of CRON_ERROR_MATCHERS) {
    if (!matcher.test(normalized)) continue;

    const detail = matcher.detail?.(normalized);
    if (detail) {
      if (detail !== normalized) {
        return t(`${matcher.key}Detail` as 'errors.runnerStartFailedDetail', {
          detail: translateCronError(detail, t),
          defaultValue: normalized,
        });
      }

      // detail === normalized: the matcher already consumed the full message (e.g. generic
      // "failed"/"timed out" patterns). Recursing would match the same matcher forever.
      return t(matcher.key, {
        detail: normalized,
        defaultValue: normalized,
      });
    }

    return t(matcher.key, { defaultValue: normalized });
  }

  return t('errors.unknown', { detail: normalized, defaultValue: normalized });
}

export function formatCronRelativeTime(date: string | Date, t: TFunction<'cron'>): string {
  const now = new Date();
  const then = new Date(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) {
    return t('relativeTime.justNow');
  }
  if (diffMin < 60) {
    return t('relativeTime.minutesAgo', { count: diffMin });
  }
  if (diffHour < 24) {
    return t('relativeTime.hoursAgo', { count: diffHour });
  }
  if (diffDay < 7) {
    return t('relativeTime.daysAgo', { count: diffDay });
  }
  return then.toLocaleDateString();
}

export function resolveCronAgentLabel(
  agentId: string | undefined,
  agents: Array<{ id: string; name: string }>,
  t: TFunction<'cron'>,
): string {
  const agent = agentId ? agents.find((item) => item.id === agentId) : undefined;
  const name = agent?.name ?? agentId ?? '';
  if (agentId === 'main' || name === 'Main Agent') {
    return t('card.mainAgent');
  }
  return name;
}
