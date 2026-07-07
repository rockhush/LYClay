import { evaluateCommandPolicy } from './command-policy';
import { evaluateNetworkPolicy } from './network-policy';
import { evaluateOpenTargetPolicy } from './open-target-policy';
import { evaluatePathPolicy } from './path-policy';
import { evaluatePromptInjectionPolicy } from './prompt-injection-policy';
import { auditPolicyDecision } from './audit-log';
import { applyCurrentSecurityModeToDecision } from './security-mode';
import type { SecurityDecision, SecurityPolicyRequest, SecurityPolicyResult } from './types';

function errorCodeForDecision(kind: SecurityPolicyRequest['kind'], decision: SecurityDecision): string {
  if (decision.action === 'deny') return decision.code;
  return `${kind.toUpperCase().replace(/-/g, '_')}_REQUIRES_CONFIRMATION`;
}

export async function evaluateSecurityPolicy(request: SecurityPolicyRequest): Promise<SecurityPolicyResult> {
  let policyResult: SecurityPolicyResult;
  switch (request.kind) {
    case 'file': {
      const result = await evaluatePathPolicy({
        path: request.path,
        capability: request.operation,
        source: request.source,
        baseDir: request.baseDir,
        allowedRoots: request.allowedRoots,
      });
      policyResult = {
        kind: 'file',
        decision: result.decision,
        result,
      };
      break;
    }
    case 'command': {
      const { kind: _kind, ...commandRequest } = request;
      const result = await evaluateCommandPolicy(commandRequest);
      policyResult = {
        kind: 'command',
        decision: result.decision,
        result,
      };
      break;
    }
    case 'network': {
      const { kind: _kind, ...networkRequest } = request;
      const result = await evaluateNetworkPolicy(networkRequest);
      policyResult = {
        kind: 'network',
        decision: result.decision,
        result,
      };
      break;
    }
    case 'open-target': {
      const { kind: _kind, ...openTargetRequest } = request;
      const result = await evaluateOpenTargetPolicy(openTargetRequest);
      policyResult = {
        kind: 'open-target',
        decision: result.decision,
        result,
      };
      break;
    }
    case 'prompt-scan': {
      const { kind: _kind, ...promptScanRequest } = request;
      const result = evaluatePromptInjectionPolicy(promptScanRequest);
      policyResult = {
        kind: 'prompt-scan',
        decision: result.decision,
        result,
      };
      break;
    }
    default: {
      const exhaustive: never = request;
      throw new Error(`Unsupported security policy request: ${JSON.stringify(exhaustive)}`);
    }
  }
  policyResult = {
    ...policyResult,
    decision: await applyCurrentSecurityModeToDecision(policyResult.decision),
  } as SecurityPolicyResult;
  if ('result' in policyResult && policyResult.result && typeof policyResult.result === 'object' && 'decision' in policyResult.result) {
    policyResult = {
      ...policyResult,
      result: {
        ...policyResult.result,
        decision: policyResult.decision,
      },
    } as SecurityPolicyResult;
  }
  auditPolicyDecision(request, policyResult);
  return policyResult;
}

export async function assertSecurityAllowed(request: SecurityPolicyRequest): Promise<SecurityPolicyResult> {
  const result = await evaluateSecurityPolicy(request);
  if (result.decision.action !== 'allow') {
    const error = new Error(result.decision.reasons.join('; ') || 'Security policy denied the request');
    (error as Error & { code?: string; decision?: SecurityDecision; policyResult?: SecurityPolicyResult }).code =
      errorCodeForDecision(request.kind, result.decision);
    (error as Error & { code?: string; decision?: SecurityDecision; policyResult?: SecurityPolicyResult }).decision =
      result.decision;
    (error as Error & { code?: string; decision?: SecurityDecision; policyResult?: SecurityPolicyResult }).policyResult =
      result;
    throw error;
  }
  return result;
}
