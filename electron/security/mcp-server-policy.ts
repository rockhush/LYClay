import crypto from 'node:crypto';
import type { McpServerEntry } from '../utils/mcp-json';

const FINGERPRINT_KEYS = [
  'type',
  'transport',
  'command',
  'args',
  'url',
  'env',
  'headers',
  'cwd',
  'workingDirectory',
] as const;

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function getMcpServerTransport(server: McpServerEntry): string {
  return server.type ?? server.transport ?? (server.command ? 'stdio' : 'unknown');
}

export function buildMcpServerFingerprint(serverName: string, server: McpServerEntry): string {
  const securityConfig = Object.fromEntries(
    FINGERPRINT_KEYS
      .filter((key) => server[key] !== undefined)
      .map((key) => [key, stableValue(server[key])]),
  );
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({ serverName, securityConfig }))
    .digest('hex');
}

export function describeMcpServer(server: McpServerEntry): string {
  const transport = getMcpServerTransport(server);
  if (transport === 'stdio') {
    return [server.command, ...(server.args ?? [])].filter(Boolean).join(' ');
  }
  return server.url ?? transport;
}

export function getMcpServerConfirmationRisk(server: McpServerEntry): 'medium' | 'high' {
  return getMcpServerTransport(server) === 'stdio' ? 'high' : 'medium';
}

export function getMcpServerConfirmationReasons(server: McpServerEntry): string[] {
  if (getMcpServerTransport(server) === 'stdio') {
    return ['stdio MCP servers start a local process and require explicit confirmation'];
  }
  return ['Remote MCP servers can access external services and require confirmation'];
}
