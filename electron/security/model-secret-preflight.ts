import crypto from 'node:crypto';
import { auditSecurityEvent } from './audit-log';
import { requestSecurityConfirmation } from './confirmation-service';
import { scanSecrets } from './secret-scanner';
import type { SecretFinding } from './secret-scanner';
import type { SecurityRisk } from './types';

const sessionApprovals = new Set<string>();

function maxRisk(findings: SecretFinding[]): SecurityRisk {
  if (findings.some((finding) => finding.risk === 'critical')) return 'critical';
  return findings.length > 0 ? 'high' : 'low';
}

function summarizeTypes(findings: SecretFinding[]): string[] {
  return [...new Set(findings.map((finding) => finding.type))].sort();
}

function approvalFingerprint(source: string, text: string, findings: SecretFinding[]): string {
  return [
    source,
    crypto.createHash('sha256').update(text).digest('hex'),
    summarizeTypes(findings).join(','),
  ].join('\n');
}

function toError(message: string, code: string): Error & { code?: string } {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

export interface ModelSecretPreflightResult {
  allowed: true;
  matchedTypes: string[];
  count: number;
  risk: SecurityRisk;
}

export function resetModelSecretPreflightForTests(): void {
  sessionApprovals.clear();
}

export async function assertModelSecretsAllowedBeforeSend(
  text: string,
  source: string,
): Promise<ModelSecretPreflightResult> {
  const findings = scanSecrets(text);
  if (findings.length === 0) {
    return {
      allowed: true,
      matchedTypes: [],
      count: 0,
      risk: 'low',
    };
  }

  const matchedTypes = summarizeTypes(findings);
  const risk = maxRisk(findings);
  const fingerprint = approvalFingerprint(source, text, findings);
  if (sessionApprovals.has(fingerprint)) {
    return {
      allowed: true,
      matchedTypes,
      count: findings.length,
      risk,
    };
  }

  auditSecurityEvent({
    source,
    capability: 'model-secret',
    operation: 'preflight',
    target: `${findings.length} secret-like value(s): ${matchedTypes.join(', ')}`,
    decision: 'prompt',
    risk,
    reasons: ['Message content contains secret-like values before model send'],
    metadata: {
      count: findings.length,
      types: matchedTypes,
      excerpts: findings.slice(0, 5).map((finding) => finding.excerpt),
    },
  });

  const response = await requestSecurityConfirmation({
    kind: 'model-secret',
    source,
    risk,
    target: {
      summary: `${findings.length} secret-like value(s)`,
      secretTypes: matchedTypes,
      excerpts: findings.slice(0, 5).map((finding) => finding.excerpt),
    },
    reasons: ['Message content contains secret-like values before model send'],
  });

  if (response.choice === 'deny') {
    throw toError('Model send denied because message contains secret-like values', 'MODEL_SECRET_DENIED_BY_USER');
  }

  if (response.choice === 'allow-session' || response.choice === 'allow-persistent') {
    sessionApprovals.add(fingerprint);
  }

  return {
    allowed: true,
    matchedTypes,
    count: findings.length,
    risk,
  };
}

export async function assertGatewayRpcModelSecretsAllowed(method: string, params: unknown): Promise<void> {
  if (method !== 'chat.send') return;
  if (!params || typeof params !== 'object') return;
  const message = (params as Record<string, unknown>).message;
  if (typeof message !== 'string' || !message.trim()) return;
  await assertModelSecretsAllowedBeforeSend(message, 'gateway:rpc:chat.send');
}
