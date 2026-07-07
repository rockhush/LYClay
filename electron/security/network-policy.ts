import { isIP } from 'node:net';
import type { NetworkPolicyRequest, NetworkPolicyResult, SecurityDecision, SecurityRisk } from './types';
import { applyCurrentSecurityModeToDecision } from './security-mode';
import { findDomainGrant } from './permission-store';
import { scanSecrets } from './secret-scanner';

// Built-in domains cover first-party AI providers and common package/code
// sources. User-approved domains are stored separately in permission-store.
const DEFAULT_ALLOWED_DOMAINS = [
  'api.openai.com',
  'chatgpt.com',
  'api.anthropic.com',
  'api.minimax.chat',
  'open.bigmodel.cn',
  'generativelanguage.googleapis.com',
  'registry.npmjs.org',
  'github.com',
  'raw.githubusercontent.com',
];

// Fixed company-internal systems that are intentionally trusted even when
// they use private addressing and plain HTTP. Keep this list host-specific;
// never widen it to an RFC1918 subnet.
const DEFAULT_TRUSTED_INTERNAL_HOSTS = new Set([
  '10.120.52.2',
]);

const PUBLIC_READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const URL_SHORTENER_DOMAINS = new Set([
  'bit.ly',
  'goo.gl',
  'is.gd',
  'ow.ly',
  't.co',
  'tiny.cc',
  'tinyurl.com',
]);
const DANGEROUS_DOWNLOAD_EXTENSIONS = new Set([
  '.app',
  '.bat',
  '.cmd',
  '.com',
  '.dmg',
  '.exe',
  '.hta',
  '.js',
  '.jse',
  '.msi',
  '.msp',
  '.pkg',
  '.ps1',
  '.reg',
  '.scr',
  '.sh',
  '.vbs',
  '.vbe',
]);

function allow(reasons: string[], risk: SecurityRisk = 'low'): SecurityDecision {
  return { action: 'allow', risk, reasons };
}

function prompt(reasons: string[], risk: SecurityRisk = 'medium'): SecurityDecision {
  return { action: 'prompt', risk, reasons, promptLevel: risk === 'high' ? 'high' : 'normal', allowRememberChoice: true };
}

function deny(code: string, reasons: string[], risk: SecurityRisk = 'high', hardDeny = false): SecurityDecision {
  return { action: 'deny', risk, reasons, code, ...(hardDeny ? { hardDeny: true } : {}) };
}

function isAllowedProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:' || protocol === 'ws:' || protocol === 'wss:';
}

function isInsecureWebSocket(protocol: string): boolean {
  return protocol === 'ws:';
}

function parseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

function defaultPort(protocol: string): number | null {
  if (protocol === 'http:') return 80;
  if (protocol === 'https:') return 443;
  if (protocol === 'ws:') return 80;
  if (protocol === 'wss:') return 443;
  return null;
}

function effectivePort(url: URL): number | null {
  if (url.port) return Number(url.port);
  return defaultPort(url.protocol);
}

function normalizedMethod(request: NetworkPolicyRequest): string {
  return (request.method ?? 'GET').toUpperCase();
}

function headersToText(headers: HeadersInit | undefined): string {
  if (!headers) return '';
  try {
    return [...new Headers(headers).entries()].map(([key, value]) => `${key}: ${value}`).join('\n');
  } catch {
    return '';
  }
}

function bodyToText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body == null) return '';
  if (typeof body === 'object') {
    try {
      return JSON.stringify(body);
    } catch {
      return String(body);
    }
  }
  return String(body);
}

function outboundSecretTypes(request: NetworkPolicyRequest, parsed: URL): string[] {
  const text = [
    parsed.search,
    headersToText(request.headers),
    bodyToText(request.body),
  ].filter(Boolean).join('\n');
  return [...new Set(scanSecrets(text).map((finding) => finding.type))];
}

function downloadExtension(parsed: URL): string | null {
  const fileName = parsed.pathname.split('/').pop()?.toLowerCase() ?? '';
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return null;
  const extension = fileName.slice(dot);
  return DANGEROUS_DOWNLOAD_EXTENSIONS.has(extension) ? extension : null;
}

function isDefaultPort(parsed: URL): boolean {
  const port = effectivePort(parsed);
  return port === defaultPort(parsed.protocol);
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/\.$/, '');
}

function parseIntegerIpv4(hostname: string): string | null {
  const value = hostname.toLowerCase();
  let parsed: number;
  if (/^0x[0-9a-f]+$/.test(value)) {
    parsed = Number.parseInt(value.slice(2), 16);
  } else if (/^\d+$/.test(value)) {
    parsed = Number.parseInt(value, 10);
  } else {
    return null;
  }
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffffffff) return null;
  return [
    (parsed >>> 24) & 255,
    (parsed >>> 16) & 255,
    (parsed >>> 8) & 255,
    parsed & 255,
  ].join('.');
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    result = (result << 8) + value;
  }
  return result >>> 0;
}

function isIpv4InRange(ip: string, cidrBase: string, bits: number): boolean {
  const value = ipv4ToNumber(ip);
  const base = ipv4ToNumber(cidrBase);
  if (value === null || base === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

function privateAddressReason(hostname: string): string | null {
  const normalized = normalizeHostname(hostname);
  const maybeIntegerIp = parseIntegerIpv4(normalized);
  const host = maybeIntegerIp ?? normalized;

  // This stage blocks literal private/local addresses before the request leaves
  // the app. DNS-resolution based private IP detection belongs in the later
  // proxy/sandbox layer because it needs the resolved address for each request.
  if (host === 'localhost') return 'localhost is restricted to explicitly allowed ports';
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return 'IPv6 localhost is restricted to explicitly allowed ports';

  if (isIP(host) === 4) {
    if (isIpv4InRange(host, '127.0.0.0', 8)) return 'IPv4 localhost is restricted to explicitly allowed ports';
    if (isIpv4InRange(host, '10.0.0.0', 8)) return 'Private IPv4 networks are blocked';
    if (isIpv4InRange(host, '172.16.0.0', 12)) return 'Private IPv4 networks are blocked';
    if (isIpv4InRange(host, '192.168.0.0', 16)) return 'Private IPv4 networks are blocked';
    if (isIpv4InRange(host, '169.254.0.0', 16)) return 'Link-local and metadata IPv4 addresses are blocked';
  }

  if (isIP(host) === 6) {
    const compact = host.toLowerCase();
    if (compact.startsWith('fc') || compact.startsWith('fd')) return 'Unique local IPv6 networks are blocked';
    if (compact.startsWith('fe8') || compact.startsWith('fe9') || compact.startsWith('fea') || compact.startsWith('feb')) {
      return 'Link-local IPv6 networks are blocked';
    }
  }

  return null;
}

function privateAddressHardDenyReason(hostname: string): string | null {
  const normalized = normalizeHostname(hostname);
  const maybeIntegerIp = parseIntegerIpv4(normalized);
  const host = maybeIntegerIp ?? normalized;

  if (isIP(host) === 4 && isIpv4InRange(host, '169.254.0.0', 16)) {
    return 'Link-local and metadata IPv4 addresses are blocked';
  }

  if (isIP(host) === 6) {
    const compact = host.toLowerCase();
    if (compact.startsWith('fe8') || compact.startsWith('fe9') || compact.startsWith('fea') || compact.startsWith('feb')) {
      return 'Link-local IPv6 networks are blocked';
    }
  }

  return null;
}

function isLocalhost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  const integerIp = parseIntegerIpv4(normalized);
  const host = integerIp ?? normalized;
  return host === 'localhost'
    || host === '::1'
    || host === '0:0:0:0:0:0:0:1'
    || (isIP(host) === 4 && isIpv4InRange(host, '127.0.0.0', 8));
}

function domainMatches(hostname: string, allowedDomain: string): boolean {
  const host = normalizeHostname(hostname);
  const domain = normalizeHostname(allowedDomain);
  // Dot-delimited matching prevents "trusted.com.evil.test" from inheriting a
  // grant or allowlist entry for "trusted.com".
  return host === domain || host.endsWith(`.${domain}`);
}

function isAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  return allowedDomains.some((domain) => domainMatches(hostname, domain));
}

export async function evaluateNetworkPolicy(request: NetworkPolicyRequest): Promise<NetworkPolicyResult> {
  const parsed = parseUrl(request.url);
  if (!parsed) {
    return {
      decision: deny('NETWORK_URL_INVALID', ['Network URL is invalid']),
    };
  }

  const hostname = normalizeHostname(parsed.hostname);
  const port = effectivePort(parsed);
  const method = normalizedMethod(request);
  const intent = request.intent ?? 'connect';
  const base = {
    url: parsed.toString(),
    protocol: parsed.protocol,
    hostname,
    port,
    method,
    intent,
  };

  if (parsed.username || parsed.password) {
    return {
      ...base,
      matchedRule: 'url-credentials',
      decision: deny('NETWORK_URL_CREDENTIALS', ['URLs with embedded credentials are blocked'], 'critical', true),
    };
  }

  if (!isAllowedProtocol(parsed.protocol)) {
    return {
      ...base,
      matchedRule: 'protocol',
      decision: deny('NETWORK_PROTOCOL_BLOCKED', [`Protocol ${parsed.protocol} is not allowed`], 'critical', true),
    };
  }

  if (isLocalhost(hostname)) {
    if (port !== null && (request.allowLocalhostPorts ?? []).includes(port)) {
      return {
        ...base,
        matchedRule: 'localhost-port-allowlist',
        decision: allow([`Allowed localhost port ${port}`]),
      };
    }
    return {
      ...base,
      matchedRule: 'localhost-port-deny',
      decision: deny('NETWORK_LOCALHOST_PORT_BLOCKED', ['Localhost access is restricted to explicitly allowed ports'], 'high', true),
    };
  }

  const privateReason = privateAddressReason(hostname);
  const privateHardDenyReason = privateReason ? privateAddressHardDenyReason(hostname) : null;
  if (privateHardDenyReason) {
    return {
      ...base,
      matchedRule: 'private-address-hard-deny',
      decision: deny('NETWORK_PRIVATE_ADDRESS_BLOCKED', [privateHardDenyReason], 'high', true),
    };
  }

  const secretTypes = outboundSecretTypes(request, parsed);
  if (secretTypes.length > 0) {
    return {
      ...base,
      matchedRule: 'outbound-secret',
      decision: deny(
        'NETWORK_SECRET_EXFILTRATION_BLOCKED',
        [`Outbound network request contains sensitive data: ${secretTypes.join(', ')}`],
        'critical',
        true,
      ),
    };
  }

  if (DEFAULT_TRUSTED_INTERNAL_HOSTS.has(hostname)) {
    return {
      ...base,
      matchedRule: 'trusted-internal-host',
      decision: allow([`Allowed trusted internal host ${hostname}`]),
    };
  }

  // User-approved grants are explicit trust for the target host. They can
  // allow intranet hosts and plain HTTP endpoints that the user configured in
  // Settings. Hard denials above still win: invalid protocol, URL credentials,
  // localhost port policy, link-local metadata, and secret exfiltration.
  const grant = await findDomainGrant(hostname, 'connect');
  if (grant) {
    return {
      ...base,
      matchedRule: 'domain-grant',
      decision: allow([`Allowed by ${grant.source} domain grant`]),
    };
  }

  const dangerousExtension = downloadExtension(parsed);
  if (dangerousExtension && !request.confirmed) {
    return {
      ...base,
      matchedRule: 'dangerous-download',
      decision: prompt([`Downloading ${dangerousExtension} files requires confirmation`], 'high'),
    };
  }

  if (
    intent === 'public-read'
    && parsed.protocol === 'https:'
    && PUBLIC_READ_METHODS.has(method)
  ) {
    if (isIP(hostname) !== 0 && !request.confirmed) {
      return {
        ...base,
        matchedRule: 'public-read-ip-address',
        decision: prompt(['Public web reads using a raw IP address require confirmation'], 'medium'),
      };
    }
    if (URL_SHORTENER_DOMAINS.has(hostname) && !request.confirmed) {
      return {
        ...base,
        matchedRule: 'public-read-short-url',
        decision: prompt([`Shortened URLs from ${hostname} require confirmation`], 'medium'),
      };
    }
    if (!isDefaultPort(parsed) && !request.confirmed) {
      return {
        ...base,
        matchedRule: 'public-read-non-default-port',
        decision: prompt([`Public web reads using port ${port} require confirmation`], 'medium'),
      };
    }
    return {
      ...base,
      matchedRule: 'public-https-read',
      decision: allow([`Allowed public HTTPS ${method} read from ${hostname}`]),
    };
  }

  if (intent === 'public-read' && !PUBLIC_READ_METHODS.has(method) && !request.confirmed) {
    return {
      ...base,
      matchedRule: 'public-read-method',
      decision: prompt([`${method} requests can send data and require confirmation`], 'high'),
    };
  }

  if (intent === 'public-read' && parsed.protocol === 'http:' && !request.confirmed) {
    return {
      ...base,
      matchedRule: 'public-read-insecure-http',
      decision: prompt(['Unencrypted public web reads require confirmation'], 'high'),
    };
  }

  const allowedDomains = [...DEFAULT_ALLOWED_DOMAINS, ...(request.allowedDomains ?? [])];
  if (isInsecureWebSocket(parsed.protocol) && !request.confirmed) {
    return {
      ...base,
      matchedRule: 'insecure-websocket',
      decision: prompt(['Unencrypted WebSocket connections require confirmation'], 'high'),
    };
  }

  if (isAllowedDomain(hostname, allowedDomains)) {
    return {
      ...base,
      matchedRule: 'domain-allowlist',
      decision: allow([`Allowed domain ${hostname}`]),
    };
  }

  if (privateReason) {
    return {
      ...base,
      matchedRule: 'private-address',
      decision: deny('NETWORK_PRIVATE_ADDRESS_BLOCKED', [privateReason], 'high', true),
    };
  }

  if (request.confirmed) {
    return {
      ...base,
      matchedRule: 'confirmed-public-domain',
      decision: allow(['Allowed after user confirmation'], 'medium'),
    };
  }

  return {
    ...base,
    matchedRule: 'unknown-public-domain',
    decision: prompt([`Network access to ${hostname} requires confirmation`], 'medium'),
  };
}

export async function assertNetworkAllowed(request: NetworkPolicyRequest): Promise<NetworkPolicyResult> {
  const rawResult = await evaluateNetworkPolicy(request);
  const result = {
    ...rawResult,
    decision: await applyCurrentSecurityModeToDecision(rawResult.decision),
  };
  if (result.decision.action !== 'allow') {
    const error = new Error(result.decision.reasons.join('; '));
    (error as Error & { code?: string; decision?: SecurityDecision }).code =
      result.decision.action === 'deny' ? result.decision.code : 'NETWORK_REQUIRES_CONFIRMATION';
    (error as Error & { code?: string; decision?: SecurityDecision }).decision = result.decision;
    throw error;
  }
  return result;
}
