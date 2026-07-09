import type { McpConfigFile, McpTransportType } from './mcp-json';
import { evaluatePromptInjectionPolicy } from '../security/prompt-injection-policy';
import { evaluateSecurityPolicy } from '../security/policy-engine';

const TRANSPORTS: ReadonlySet<McpTransportType> = new Set(['streamable-http', 'stdio', 'sse']);

const ALLOWED_COMMAND_BASENAMES = new Set([
  'npx', 'node', 'node.exe', 'uvx', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
]);

function basenameFirstToken(command: string): string {
  const trimmed = command.trim();
  const parts = trimmed.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? trimmed;
  return (last.split(/\s+/)[0] ?? '').toLowerCase();
}

function looksLikeShellInjection(command: string): boolean {
  return /[;&|`$]|\n|\r/.test(command);
}

function isPortableRelativeEntry(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('~')) return false;
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return false;
  try {
    if (new URL(trimmed).protocol) return false;
  } catch {
    // Not a URL, continue with path checks.
  }
  const normalized = trimmed.replace(/\\/g, '/');
  return normalized !== '..' && !normalized.startsWith('../') && !normalized.includes('/../');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function collectDescriptionFields(value: unknown, path: string, output: Array<{ label: string; text: string }>): void {
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    const normalizedKey = key.toLowerCase();
    if (
      typeof child === 'string'
      && ['description', 'instructions', 'instruction', 'prompt', 'systemprompt', 'system_prompt'].includes(normalizedKey)
    ) {
      output.push({ label: childPath, text: child });
      continue;
    }
    if (isRecord(child)) {
      collectDescriptionFields(child, childPath, output);
    } else if (Array.isArray(child)) {
      child.forEach((item, index) => collectDescriptionFields(item, `${childPath}[${index}]`, output));
    }
  }
}

function validateMcpPromptInjection(name: string, entry: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const fields: Array<{ label: string; text: string }> = [];
  collectDescriptionFields(entry, `Server "${name}"`, fields);

  for (const field of fields) {
    const scan = evaluatePromptInjectionPolicy({
      source: 'mcp',
      name: field.label,
      text: field.text,
    });
    if (scan.decision.action === 'deny') {
      errors.push(`${field.label}: prompt-injection scan blocked: ${scan.decision.reasons.join('; ')}`);
    }
  }

  return errors;
}

function isSecureRemoteMcpProtocol(protocol: string): boolean {
  return protocol === 'https:' || protocol === 'wss:';
}

function isRemoteMcpType(type: string | undefined): boolean {
  return type === 'streamable-http' || type === 'sse';
}

function getMcpServerType(entry: Record<string, unknown>): string | undefined {
  return typeof entry.type === 'string'
    ? entry.type
    : typeof entry.command === 'string' || entry.runtime === 'node'
      ? 'stdio'
      : typeof entry.transport === 'string'
        ? entry.transport
        : undefined;
}

function collectRemoteMcpUrls(name: string, entry: Record<string, unknown>): Array<{ label: string; url: string }> {
  const urls: Array<{ label: string; url: string }> = [];
  for (const key of ['url', 'baseUrl', 'endpoint']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) {
      urls.push({ label: `Server "${name}".${key}`, url: value.trim() });
    }
  }
  return urls;
}

export function validateMcpServerEntry(name: string, entry: unknown): string[] {
  const errors: string[] = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`Server "${name}": value must be an object`);
    return errors;
  }
  const s = entry as Record<string, unknown>;
  const type = getMcpServerType(s);
  if (typeof type !== 'string' || !TRANSPORTS.has(type as McpTransportType)) {
    errors.push(`Server "${name}": type/transport must be one of streamable-http, stdio, sse`);
    return errors;
  }

  if (type === 'stdio') {
    const usesRuntimeNode = s.runtime === 'node';
    if (s.runtime !== undefined && s.runtime !== 'node') {
      errors.push(`Server "${name}": runtime must be node when present`);
    }
    if (usesRuntimeNode) {
      if (s.command !== undefined) {
        errors.push(`Server "${name}": runtime node entries must not also set command`);
      }
      if (typeof s.entry !== 'string' || !isPortableRelativeEntry(s.entry)) {
        errors.push(`Server "${name}": runtime node requires a portable relative entry path`);
      }
    } else if (typeof s.command !== 'string' || !s.command.trim()) {
      errors.push(`Server "${name}": stdio requires non-empty command`);
    } else if (looksLikeShellInjection(s.command)) {
      errors.push(`Server "${name}": command contains disallowed shell metacharacters`);
    } else if (!ALLOWED_COMMAND_BASENAMES.has(basenameFirstToken(s.command))) {
      errors.push(`Server "${name}": command must use an allowed launcher (e.g. npx, node, uvx)`);
    }
    if (!usesRuntimeNode && s.entry !== undefined) {
      errors.push(`Server "${name}": entry is only allowed with runtime node`);
    }
    if (s.args !== undefined) {
      if (!Array.isArray(s.args) || !s.args.every((a) => typeof a === 'string')) {
        errors.push(`Server "${name}": args must be an array of strings when present`);
      }
    }
  } else {
    if (typeof s.url !== 'string' || !s.url.trim()) {
      errors.push(`Server "${name}": ${type} requires a non-empty url`);
    } else {
      try {
        const u = new URL(s.url);
        if (!isSecureRemoteMcpProtocol(u.protocol)) {
          errors.push(`Server "${name}": url must use https or wss`);
        }
      } catch {
        errors.push(`Server "${name}": url is not a valid URL`);
      }
    }
  }

  if (s.env !== undefined) {
    if (typeof s.env !== 'object' || s.env === null || Array.isArray(s.env)) {
      errors.push(`Server "${name}": env must be an object of string values`);
    } else {
      for (const [k, v] of Object.entries(s.env)) {
        if (typeof v !== 'string') {
          errors.push(`Server "${name}": env.${k} must be a string`);
        }
      }
    }
  }

  if (s.headers !== undefined) {
    if (typeof s.headers !== 'object' || s.headers === null || Array.isArray(s.headers)) {
      errors.push(`Server "${name}": headers must be an object of string values`);
    } else {
      for (const [k, v] of Object.entries(s.headers)) {
        if (typeof v !== 'string') {
          errors.push(`Server "${name}": headers.${k} must be a string`);
        }
      }
    }
  }

  if (s.disabled !== undefined && typeof s.disabled !== 'boolean') {
    errors.push(`Server "${name}": disabled must be a boolean when present`);
  }

  if (s.tools !== undefined) {
    if (typeof s.tools !== 'object' || s.tools === null || Array.isArray(s.tools)) {
      errors.push(`Server "${name}": tools must be an object`);
    } else {
      const t = s.tools as Record<string, unknown>;
      for (const key of ['allow', 'deny'] as const) {
        if (t[key] === undefined) continue;
        if (!Array.isArray(t[key]) || !(t[key] as unknown[]).every((x) => typeof x === 'string')) {
          errors.push(`Server "${name}": tools.${key} must be an array of strings`);
        } else if ((t[key] as string[]).length === 0) {
          errors.push(`Server "${name}": tools.${key} must not be empty (omit the field instead)`);
        }
      }
    }
  }

  errors.push(...validateMcpPromptInjection(name, s));

  return errors;
}

export function validateMcpConfig(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: false, errors: ['Root must be an object'] };
  }
  const root = config as Record<string, unknown>;
  const servers = root.servers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { valid: false, errors: ['servers must be an object'] };
  }
  for (const [name, entry] of Object.entries(servers)) {
    if (!name.trim()) {
      errors.push('Empty server name key is not allowed');
      continue;
    }
    errors.push(...validateMcpServerEntry(name, entry));
  }
  return { valid: errors.length === 0, errors };
}

export async function validateMcpConfigNetworkPolicy(config: unknown): Promise<{ valid: boolean; errors: string[] }> {
  const structural = validateMcpConfig(config);
  const errors = [...structural.errors];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { valid: errors.length === 0, errors };
  }

  const coerced = coerceMcpConfig(config);
  for (const [name, entry] of Object.entries(coerced.servers)) {
    const server = entry as Record<string, unknown>;
    const type = getMcpServerType(server);
    if (!isRemoteMcpType(type)) continue;

    for (const candidate of collectRemoteMcpUrls(name, server)) {
      let parsed: URL;
      try {
        parsed = new URL(candidate.url);
      } catch {
        continue;
      }
      if (!isSecureRemoteMcpProtocol(parsed.protocol)) continue;

      const result = await evaluateSecurityPolicy({
        kind: 'network',
        url: parsed.toString(),
        source: 'settings:mcp-config',
      });
      if (result.decision.action !== 'allow') {
        errors.push(`${candidate.label}: ${result.decision.reasons.join('; ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function coerceMcpConfig(config: unknown): McpConfigFile {
  const parsed = config as McpConfigFile;
  const servers = parsed?.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)
    ? parsed.servers
    : (parsed as unknown as { mcpServers?: unknown })?.mcpServers;
  return {
    servers: servers && typeof servers === 'object' && !Array.isArray(servers)
      ? { ...servers as Record<string, import('./mcp-json').McpServerEntry> }
      : {},
  };
}
