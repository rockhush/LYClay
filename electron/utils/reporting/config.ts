/**
 * Reporting endpoint configuration.
 *
 * Base URL aligns with the company marketplace (`http://portal.srv.lstech.com`
 * by default; `http://100.0.4.203` when reachable from internal network).
 * Override via `LYCLAW_REPORT_BASE_URL` (e.g. for staging) or via in-app
 * setting in the future.
 */

import { getLyclawEnvVariable } from '../dingtalk-oauth';

const DEFAULT_REPORT_BASE_URL = 'http://portal.srv.lstech.com';
// const DEFAULT_REPORT_BASE_URL = 'http://100.0.4.203';
const TOKEN_CONSUME_PATH = '/management/claw/report/token-consume';
const SKILL_DOWNLOAD_PATH = '/management/claw/report/skill-download';
const SKILL_INVOKE_PATH = '/management/claw/report/skill-invoke';

export interface ReportingEndpoints {
  tokenConsume: string;
  skillDownload: string;
  skillInvoke: string;
}

function readBaseUrl(): string {
  // Prefer the same env-driven discovery used by DingTalk OAuth so a single
  // .env.local can flip both sets of endpoints between portal/100.0.4.203.
  const override = getLyclawEnvVariable('LYCLAW_REPORT_BASE_URL').trim();
  const base = override.length > 0 ? override : DEFAULT_REPORT_BASE_URL;
  return base.replace(/\/+$/, '');
}

export function getReportingEndpoints(): ReportingEndpoints {
  const base = readBaseUrl();
  return {
    tokenConsume: `${base}${TOKEN_CONSUME_PATH}`,
    skillDownload: `${base}${SKILL_DOWNLOAD_PATH}`,
    skillInvoke: `${base}${SKILL_INVOKE_PATH}`,
  };
}

export function getReportingBaseUrl(): string {
  return readBaseUrl();
}
