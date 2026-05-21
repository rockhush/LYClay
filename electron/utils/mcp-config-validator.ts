import type { McpConfigFile, McpTransportType } from './mcp-json';

const TRANSPORTS: ReadonlySet<McpTransportType> = new Set(['streamable-http', 'stdio', 'sse']);

const ALLOWED_COMMAND_BASENAMES = new Set([
  'npx', 'node', 'uvx', 'npm', 'pnpm', 'yarn', 'bun', 'deno',
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

export function validateMcpServerEntry(name: string, entry: unknown): string[] {
  const errors: string[] = [];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    errors.push(`Server "${name}": value must be an object`);
    return errors;
  }
  const s = entry as Record<string, unknown>;
  const type = typeof s.type === 'string'
    ? s.type
    : typeof s.command === 'string'
      ? 'stdio'
      : typeof s.transport === 'string'
        ? s.transport
        : undefined;
  if (typeof type !== 'string' || !TRANSPORTS.has(type as McpTransportType)) {
    errors.push(`Server "${name}": type/transport must be one of streamable-http, stdio, sse`);
    return errors;
  }

  if (type === 'stdio') {
    if (typeof s.command !== 'string' || !s.command.trim()) {
      errors.push(`Server "${name}": stdio requires non-empty command`);
    } else if (looksLikeShellInjection(s.command)) {
      errors.push(`Server "${name}": command contains disallowed shell metacharacters`);
    } else if (!ALLOWED_COMMAND_BASENAMES.has(basenameFirstToken(s.command))) {
      errors.push(`Server "${name}": command must use an allowed launcher (e.g. npx, node, uvx)`);
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
        if (u.protocol !== 'https:') {
          errors.push(`Server "${name}": url must use https`);
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
