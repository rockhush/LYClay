import { proxyAwareFetch } from '../utils/proxy-fetch';
import { auditSecurityEvent } from './audit-log';
import { evaluateNetworkPolicy } from './network-policy';
import { applyCurrentSecurityModeToDecision } from './security-mode';
import type { NetworkPolicyRequest, NetworkPolicyResult, SecurityDecision } from './types';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_REDIRECTS = 10;

export interface SecureNetworkFetchOptions {
  source: string;
  allowedDomains?: string[];
  allowLocalhostPorts?: number[];
  maxRedirects?: number;
  intent?: NetworkPolicyRequest['intent'];
}

function toError(result: NetworkPolicyResult): Error & { code?: string; decision?: SecurityDecision } {
  const error = new Error(result.decision.reasons.join('; ') || 'Network access blocked') as Error & {
    code?: string;
    decision?: SecurityDecision;
  };
  error.code = result.decision.action === 'deny' ? result.decision.code : 'NETWORK_REQUIRES_CONFIRMATION';
  error.decision = result.decision;
  return error;
}

function auditRedirectDecision(
  request: NetworkPolicyRequest,
  result: NetworkPolicyResult,
  fromUrl: string,
): void {
  auditSecurityEvent({
    source: request.source ?? 'unknown',
    capability: 'network',
    operation: 'redirect',
    target: result.url ?? request.url,
    decision: result.decision.action,
    risk: result.decision.risk,
    reasons: result.decision.reasons,
    code: result.decision.action === 'deny' ? result.decision.code : undefined,
    metadata: {
      fromUrl,
      toUrl: result.url ?? request.url,
      matchedRule: result.matchedRule,
    },
  });
}

function auditFetchDecision(request: NetworkPolicyRequest, result: NetworkPolicyResult): void {
  if (
    request.source === 'renderer:hostapi-fetch'
    && result.matchedRule === 'localhost-port-allowlist'
    && result.decision.action === 'allow'
    && result.decision.risk === 'low'
  ) {
    return;
  }

  auditSecurityEvent({
    source: request.source ?? 'unknown',
    capability: 'network',
    operation: request.intent ?? 'connect',
    target: result.url ?? request.url,
    decision: result.decision.action,
    risk: result.decision.risk,
    reasons: result.decision.reasons,
    code: result.decision.action === 'deny' ? result.decision.code : undefined,
    metadata: {
      method: request.method ?? 'GET',
      matchedRule: result.matchedRule,
    },
  });
}

function resolveRedirectUrl(currentUrl: string, location: string | null): string | null {
  if (!location) return null;
  try {
    return new URL(location, currentUrl).toString();
  } catch {
    return null;
  }
}

function nextRedirectMethod(method: string, status: number): string {
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

function nextRedirectBody(body: BodyInit | null | undefined, method: string, status: number): BodyInit | null | undefined {
  return nextRedirectMethod(method, status) === method ? body : undefined;
}

export async function secureProxyAwareFetch(
  input: string | URL,
  init: RequestInit | undefined,
  options: SecureNetworkFetchOptions,
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  let currentUrl = input.toString();
  let method = (init?.method ?? 'GET').toUpperCase();
  let body = init?.body;

  const initialRequest: NetworkPolicyRequest = {
    url: currentUrl,
    source: options.source,
    allowedDomains: options.allowedDomains,
    allowLocalhostPorts: options.allowLocalhostPorts,
    intent: options.intent,
    method,
    headers: init?.headers,
    body,
  };
  const rawInitialResult = await evaluateNetworkPolicy(initialRequest);
  const initialResult = {
    ...rawInitialResult,
    decision: await applyCurrentSecurityModeToDecision(rawInitialResult.decision),
  };
  auditFetchDecision(initialRequest, initialResult);
  if (initialResult.decision.action !== 'allow') throw toError(initialResult);

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await proxyAwareFetch(currentUrl, {
      ...init,
      method,
      body,
      redirect: 'manual',
    });

    if (!REDIRECT_STATUSES.has(response.status)) return response;

    const nextUrl = resolveRedirectUrl(currentUrl, response.headers.get('location'));
    if (!nextUrl) {
      throw new Error(`Network redirect is missing or invalid: ${currentUrl}`);
    }

    const redirectRequest: NetworkPolicyRequest = {
      url: nextUrl,
      source: options.source,
      allowedDomains: options.allowedDomains,
      allowLocalhostPorts: options.allowLocalhostPorts,
      intent: options.intent,
      method: nextRedirectMethod(method, response.status),
      headers: init?.headers,
      body: nextRedirectBody(body, method, response.status),
    };
    const rawRedirectResult = await evaluateNetworkPolicy(redirectRequest);
    const redirectResult = {
      ...rawRedirectResult,
      decision: await applyCurrentSecurityModeToDecision(rawRedirectResult.decision),
    };
    auditRedirectDecision(redirectRequest, redirectResult, currentUrl);
    if (redirectResult.decision.action !== 'allow') throw toError(redirectResult);

    if (redirectCount === maxRedirects) {
      throw new Error(`Too many network redirects from ${input.toString()}`);
    }

    const nextMethod = nextRedirectMethod(method, response.status);
    body = nextRedirectBody(body, method, response.status);
    method = nextMethod;
    currentUrl = nextUrl;
  }

  throw new Error(`Too many network redirects from ${input.toString()}`);
}
