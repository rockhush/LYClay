import type { SecurityDecision, SecurityMode, SecurityModeOverride } from './types';
import { getSetting, setSetting } from '../utils/store';

export const SECURITY_MODES: SecurityMode[] = ['standard', 'trusted', 'off'];
export const DEFAULT_SECURITY_MODE: SecurityMode = 'trusted';

let testSecurityMode: SecurityMode | null = null;

export function isSecurityMode(value: unknown): value is SecurityMode {
  return typeof value === 'string' && (SECURITY_MODES as string[]).includes(value);
}

export async function getSecurityMode(): Promise<SecurityMode> {
  if (testSecurityMode) return testSecurityMode;
  if (isSecurityMode(process.env.CLAWX_SECURITY_MODE)) return process.env.CLAWX_SECURITY_MODE;
  try {
    const mode = await getSetting('securityMode');
    return isSecurityMode(mode) ? mode : DEFAULT_SECURITY_MODE;
  } catch {
    return DEFAULT_SECURITY_MODE;
  }
}

export async function setSecurityMode(mode: SecurityMode): Promise<void> {
  if (!isSecurityMode(mode)) {
    throw new Error(`Unsupported security mode: ${String(mode)}`);
  }
  await setSetting('securityMode', mode);
}

export function setSecurityModeForTests(mode: SecurityMode | null): void {
  testSecurityMode = mode;
}

function originalCode(decision: SecurityDecision): string | undefined {
  return decision.action === 'deny' ? decision.code : undefined;
}

function overrideFor(
  decision: SecurityDecision,
  mode: SecurityMode,
  effectiveAction: SecurityModeOverride['effectiveAction'],
): SecurityModeOverride {
  return {
    mode,
    originalAction: decision.action,
    effectiveAction,
    originalRisk: decision.risk,
    ...(originalCode(decision) ? { originalCode: originalCode(decision) } : {}),
    hardDeny: decision.hardDeny === true || decision.risk === 'critical',
  };
}

function modeAllowDecision(decision: SecurityDecision, mode: SecurityMode): SecurityDecision {
  return {
    action: 'allow',
    risk: decision.risk,
    reasons: [
      `Allowed by ${mode} security mode`,
      ...decision.reasons,
    ],
    hardDeny: false,
    modeOverride: overrideFor(decision, mode, 'allow'),
  };
}

function retainedDenyDecision(decision: SecurityDecision, mode: SecurityMode): SecurityDecision {
  if (decision.action !== 'deny') return decision;
  return {
    ...decision,
    hardDeny: true,
    modeOverride: overrideFor(decision, mode, 'deny'),
  };
}

export function applySecurityModeToDecision(decision: SecurityDecision, mode: SecurityMode): SecurityDecision {
  if (mode === 'standard' || decision.action === 'allow') return decision;

  if (mode === 'trusted') {
    return decision.action === 'prompt' ? modeAllowDecision(decision, mode) : decision;
  }

  if (decision.action === 'prompt') return modeAllowDecision(decision, mode);

  const isHardDeny = decision.hardDeny === true || decision.risk === 'critical';
  return isHardDeny ? retainedDenyDecision(decision, mode) : modeAllowDecision(decision, mode);
}

export async function applyCurrentSecurityModeToDecision(decision: SecurityDecision): Promise<SecurityDecision> {
  return applySecurityModeToDecision(decision, await getSecurityMode());
}
