import { fileURLToPath } from 'node:url';
import { evaluateNetworkPolicy } from './network-policy';
import { evaluatePathPolicy } from './path-policy';
import type { FileCapability, OpenTargetPolicyResult, OpenTargetRequest, SecurityDecision, SecurityRisk } from './types';

function allow(reasons: string[], risk: SecurityRisk = 'low'): SecurityDecision {
  return { action: 'allow', risk, reasons };
}

function prompt(reasons: string[], risk: SecurityRisk = 'medium'): SecurityDecision {
  return { action: 'prompt', risk, reasons, promptLevel: risk === 'high' ? 'high' : 'normal', allowRememberChoice: false };
}

function deny(code: string, reasons: string[], risk: SecurityRisk = 'high'): SecurityDecision {
  return { action: 'deny', risk, reasons, code };
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function pathCapability(request: OpenTargetRequest): FileCapability {
  return request.capability === 'show-item' ? 'metadata' : 'open';
}

async function evaluateFileTarget(request: OpenTargetRequest, filePath: string): Promise<OpenTargetPolicyResult> {
  const pathResult = await evaluatePathPolicy({
    path: filePath,
    capability: pathCapability(request),
    source: request.source ?? `open-target:${request.capability}`,
    allowedRoots: request.allowedRoots,
  });

  return {
    decision: pathResult.decision,
    targetType: 'file',
    action: request.capability === 'show-item' ? 'show-item' : 'open-path',
    path: filePath,
    realPath: pathResult.pathInfo?.realPath,
    matchedRule: pathResult.matchedRoot ? 'path-policy-root' : undefined,
  };
}

export async function evaluateOpenTargetPolicy(request: OpenTargetRequest): Promise<OpenTargetPolicyResult> {
  if (typeof request.target !== 'string' || !request.target.trim()) {
    return { decision: deny('OPEN_TARGET_EMPTY', ['Open target must be a non-empty string']) };
  }

  if (request.capability !== 'open-external') {
    return await evaluateFileTarget(request, request.target);
  }

  const parsed = parseUrl(request.target);
  if (!parsed) {
    return { decision: deny('OPEN_TARGET_URL_INVALID', ['Open target URL is invalid']) };
  }

  if (parsed.protocol === 'file:') {
    try {
      return await evaluateFileTarget(request, fileURLToPath(parsed));
    } catch (error) {
      return {
        targetType: 'file',
        protocol: parsed.protocol,
        decision: deny('OPEN_TARGET_FILE_URL_INVALID', [`Cannot parse file URL: ${error instanceof Error ? error.message : String(error)}`]),
      };
    }
  }

  const blockedProtocols = new Set(['javascript:', 'data:', 'vbscript:']);
  if (blockedProtocols.has(parsed.protocol)) {
    return {
      targetType: 'url',
      url: parsed.toString(),
      protocol: parsed.protocol,
      matchedRule: 'dangerous-protocol',
      decision: deny('OPEN_TARGET_PROTOCOL_BLOCKED', [`Protocol ${parsed.protocol} is blocked`], 'critical'),
    };
  }

  if (parsed.protocol === 'mailto:') {
    return {
      targetType: 'url',
      action: 'open-url',
      url: parsed.toString(),
      protocol: parsed.protocol,
      matchedRule: 'mailto-confirmation',
      decision: prompt(['Opening an email client requires confirmation'], 'medium'),
    };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      targetType: 'url',
      url: parsed.toString(),
      protocol: parsed.protocol,
      matchedRule: 'custom-protocol',
      decision: deny('OPEN_TARGET_PROTOCOL_BLOCKED', [`Protocol ${parsed.protocol} is not allowed`], 'high'),
    };
  }

  const networkResult = await evaluateNetworkPolicy({
    url: parsed.toString(),
    source: request.source ?? 'open-target',
    intent: 'public-read',
    method: 'GET',
  });
  const risk = parsed.protocol === 'http:' && networkResult.decision.action === 'prompt'
    ? 'high'
    : networkResult.decision.risk;
  const reasons = parsed.protocol === 'http:' && networkResult.decision.action === 'prompt'
    ? [...networkResult.decision.reasons, 'Plain HTTP links require stronger confirmation']
    : networkResult.decision.reasons;

  return {
    targetType: 'url',
    action: 'open-url',
    url: networkResult.url ?? parsed.toString(),
    protocol: parsed.protocol,
    hostname: networkResult.hostname ?? parsed.hostname,
    matchedRule: networkResult.matchedRule,
    decision: networkResult.decision.action === 'prompt'
      ? prompt(reasons, risk)
      : networkResult.decision.action === 'allow'
        ? allow(reasons, networkResult.decision.risk)
        : networkResult.decision,
  };
}

export async function assertOpenTargetAllowed(request: OpenTargetRequest): Promise<OpenTargetPolicyResult> {
  const result = await evaluateOpenTargetPolicy(request);
  if (result.decision.action !== 'allow') {
    const error = new Error(result.decision.reasons.join('; '));
    (error as Error & { code?: string; decision?: SecurityDecision }).code =
      result.decision.action === 'deny' ? result.decision.code : 'OPEN_TARGET_REQUIRES_CONFIRMATION';
    (error as Error & { code?: string; decision?: SecurityDecision }).decision = result.decision;
    throw error;
  }
  return result;
}
