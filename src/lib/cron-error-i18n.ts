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

      return t(matcher.key, {
        detail: translateCronError(detail, t),
        defaultValue: normalized,
      });
    }

    return t(matcher.key, { defaultValue: normalized });
  }

  return t('errors.unknown', { detail: normalized, defaultValue: normalized });
}
