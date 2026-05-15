import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { ConnectorConfig, McpConfigFile, McpServerStatus } from '@/types/connector';

export type ConnectorPageTab = 'builtIn' | 'custom';

interface ConnectorsState {
  connectorPageTab: ConnectorPageTab;
  setConnectorPageTab: (tab: ConnectorPageTab) => void;

  connectors: ConnectorConfig[];
  connectorsLoading: boolean;
  connectorsError: string | null;

  mcpServers: McpServerStatus[];
  mcpServersLoading: boolean;
  mcpServersError: string | null;

  mcpConfig: McpConfigFile | null;
  mcpConfigPath: string;
  mcpConfigLoading: boolean;
  mcpConfigError: string | null;

  fetchConnectors: () => Promise<void>;
  installConnector: (connectorId: 'notion' | 'github', config?: Record<string, unknown>) => Promise<void>;
  uninstallConnector: (connectorId: 'notion' | 'github') => Promise<void>;
  enableConnector: (connectorId: 'notion' | 'github') => Promise<void>;
  disableConnector: (connectorId: 'notion' | 'github') => Promise<void>;

  fetchMcpServers: (options?: { background?: boolean }) => Promise<void>;
  enableMcpServer: (name: string) => Promise<void>;
  disableMcpServer: (name: string) => Promise<void>;

  fetchMcpConfig: () => Promise<void>;
  saveMcpConfig: (config: McpConfigFile) => Promise<void>;
  validateMcpConfig: (config: McpConfigFile) => Promise<{ valid: boolean; errors: string[] }>;

  fetchMcpServerTools: (serverName: string) => Promise<{
    tools: string[];
    denied: string[];
    allowed: string[] | null;
    gateway: boolean;
  }>;
  denyMcpTool: (serverName: string, toolName: string) => Promise<void>;
  undenyMcpTool: (serverName: string, toolName: string) => Promise<void>;
  deleteMcpServer: (serverName: string) => Promise<void>;
}

export const useConnectorsStore = create<ConnectorsState>((set, get) => ({
  connectorPageTab: 'builtIn',
  setConnectorPageTab: (tab) => set({ connectorPageTab: tab }),

  connectors: [],
  connectorsLoading: false,
  connectorsError: null,
  mcpServers: [],
  mcpServersLoading: false,
  mcpServersError: null,
  mcpConfig: null,
  mcpConfigPath: '',
  mcpConfigLoading: false,
  mcpConfigError: null,

  fetchConnectors: async () => {
    set({ connectorsLoading: true, connectorsError: null });
    try {
      const data = await hostApiFetch<ConnectorConfig[]>('/api/connectors');
      set({ connectors: data, connectorsLoading: false });
    } catch (error) {
      set({ connectorsError: String(error), connectorsLoading: false });
    }
  },

  installConnector: async (connectorId, config) => {
    await hostApiFetch<{ success: boolean }>('/api/connectors/install', {
      method: 'POST',
      body: JSON.stringify({ id: connectorId, config }),
    });
    await get().fetchMcpServers({ background: true });
    await get().fetchMcpConfig();
  },

  uninstallConnector: async (connectorId) => {
    await hostApiFetch<{ success: boolean }>(`/api/connectors/${encodeURIComponent(connectorId)}`, {
      method: 'DELETE',
    });
    await get().fetchMcpServers({ background: true });
    await get().fetchMcpConfig();
  },

  enableConnector: async (connectorId) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/connectors/${encodeURIComponent(connectorId)}/enable`,
      { method: 'POST' },
    );
    await get().fetchMcpServers({ background: true });
    await get().fetchMcpConfig();
  },

  disableConnector: async (connectorId) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/connectors/${encodeURIComponent(connectorId)}/disable`,
      { method: 'POST' },
    );
    await get().fetchMcpServers({ background: true });
    await get().fetchMcpConfig();
  },

  fetchMcpServers: async (options?: { background?: boolean }) => {
    const background = options?.background === true;
    if (!background) {
      set({ mcpServersLoading: true, mcpServersError: null });
    }
    try {
      const data = await hostApiFetch<McpServerStatus[]>('/api/mcp/servers');
      if (background) {
        set({ mcpServers: data, mcpServersError: null });
      } else {
        set({ mcpServers: data, mcpServersLoading: false, mcpServersError: null });
      }
    } catch (error) {
      const msg = String(error);
      if (background) {
        set({ mcpServersError: msg });
      } else {
        set({ mcpServersError: msg, mcpServersLoading: false });
      }
    }
  },

  enableMcpServer: async (name) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/mcp/servers/${encodeURIComponent(name)}/enable`,
      { method: 'POST' },
    );
    await get().fetchMcpServers({ background: true });
    await get().fetchMcpConfig();
  },

  disableMcpServer: async (name) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/mcp/servers/${encodeURIComponent(name)}/disable`,
      { method: 'POST' },
    );
    await get().fetchMcpServers({ background: true });
    await get().fetchMcpConfig();
  },

  fetchMcpConfig: async () => {
    set({ mcpConfigLoading: true, mcpConfigError: null });
    try {
      const data = await hostApiFetch<{ config: McpConfigFile; path: string }>('/api/mcp/config');
      set({
        mcpConfig: data.config,
        mcpConfigPath: data.path,
        mcpConfigLoading: false,
      });
    } catch (error) {
      set({ mcpConfigLoading: false, mcpConfigError: String(error) });
    }
  },

  saveMcpConfig: async (config) => {
    await hostApiFetch<{ success: boolean }>('/api/mcp/config', {
      method: 'PUT',
      body: JSON.stringify({ config }),
    });
    await get().fetchMcpConfig();
    await get().fetchMcpServers({ background: true });
  },

  validateMcpConfig: async (config) => {
    return hostApiFetch<{ valid: boolean; errors: string[] }>('/api/mcp/config/validate', {
      method: 'POST',
      body: JSON.stringify({ config }),
    });
  },

  fetchMcpServerTools: async (serverName) => {
    return hostApiFetch<{
      tools: string[];
      denied: string[];
      allowed: string[] | null;
      gateway: boolean;
    }>(`/api/mcp/servers/${encodeURIComponent(serverName)}/tools`);
  },

  denyMcpTool: async (serverName, toolName) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/mcp/servers/${encodeURIComponent(serverName)}/tools/deny`,
      { method: 'POST', body: JSON.stringify({ toolName }) },
    );
    await get().fetchMcpConfig();
    await get().fetchMcpServers({ background: true });
  },

  undenyMcpTool: async (serverName, toolName) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/mcp/servers/${encodeURIComponent(serverName)}/tools/deny/${encodeURIComponent(toolName)}`,
      { method: 'DELETE' },
    );
    await get().fetchMcpConfig();
    await get().fetchMcpServers({ background: true });
  },

  deleteMcpServer: async (serverName) => {
    await hostApiFetch<{ success: boolean }>(
      `/api/mcp/servers/${encodeURIComponent(serverName)}`,
      { method: 'DELETE' },
    );
    await get().fetchMcpConfig();
    await get().fetchMcpServers({ background: true });
  },
}));
