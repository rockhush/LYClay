/** Built-in catalog ids (LYClaw product layer). */
export type BuiltInConnectorId = 'notion' | 'github';

export type ConnectorType =
  | 'notion'
  | 'code'
  | 'mcp'
  | 'custom';

export type ConnectorStatus = 'available' | 'installed' | 'enabled' | 'disabled' | 'error';

export interface ConnectorConfig {
  id: string;
  type: ConnectorType;
  name: string;
  description: string;
  icon: string;
  status: ConnectorStatus;
  enabled: boolean;
  version?: string;
  author?: string;
  config?: Record<string, unknown>;
  requiresConfig: boolean;
  source?: 'bundled' | 'custom';
}

export type McpTransportType = 'streamable-http' | 'stdio' | 'sse';

export interface McpServerConfig {
  type?: McpTransportType;
  transport?: 'streamable-http' | 'sse';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
  headers?: Record<string, string>;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
}

export interface McpConfigFile {
  servers: Record<string, McpServerConfig>;
}

export interface McpServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  totalTools: number;
  type?: string;
  url?: string;
  command?: string;
  lastError?: string;
  lastConnectedAt?: number;
  deniedTools?: string[];
  allowedTools?: string[];
}
