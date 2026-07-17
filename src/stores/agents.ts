import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type { ChannelType } from '@/types/channel';
import type { AgentSummary, AgentsSnapshot } from '@/types/agent';

interface AgentsState {  
  agents: AgentSummary[];
  defaultAgentId: string;
  defaultModelRef: string | null;
  configuredChannelTypes: string[];
  channelOwners: Record<string, string>;
  channelAccountOwners: Record<string, string>;
  loading: boolean;
  error: string | null;
  fetchAgents: (options?: { force?: boolean }) => Promise<void>;
  createAgent: (name: string, options?: { inheritWorkspace?: boolean }) => Promise<void>;
  updateAgent: (agentId: string, name: string) => Promise<void>;
  updateAgentModel: (agentId: string, modelRef: string | null) => Promise<void>;
  deleteAgent: (agentId: string) => Promise<void>;
  assignChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  removeChannel: (agentId: string, channelType: ChannelType) => Promise<void>;
  clearError: () => void;
}

let fetchAgentsPromise: Promise<void> | null = null;
let lastFetchAgentsAt = 0;
const FETCH_AGENTS_DEDUPE_MS = 5_000;

function applySnapshot(snapshot: AgentsSnapshot | undefined) {
  return snapshot ? {
    // Host responses and persisted data are runtime input despite the static
    // type. Never let a malformed object reach ChatInput, where array methods
    // such as find/filter would crash the entire renderer.
    agents: Array.isArray(snapshot.agents) ? snapshot.agents : [],
    defaultAgentId: snapshot.defaultAgentId ?? 'main',
    defaultModelRef: snapshot.defaultModelRef ?? null,
    configuredChannelTypes: Array.isArray(snapshot.configuredChannelTypes)
      ? snapshot.configuredChannelTypes
      : [],
    channelOwners: snapshot.channelOwners ?? {},
    channelAccountOwners: snapshot.channelAccountOwners ?? {},
  } : {};
}

export const useAgentsStore = create<AgentsState>((set, get) => ({
  agents: [],
  defaultAgentId: 'main',
  defaultModelRef: null,
  configuredChannelTypes: [],
  channelOwners: {},
  channelAccountOwners: {},
  loading: false,
  error: null,

  fetchAgents: async (options) => {
    if (fetchAgentsPromise) {
      return fetchAgentsPromise;
    }
    const now = Date.now();
    if (!options?.force && get().agents.length > 0 && now - lastFetchAgentsAt < FETCH_AGENTS_DEDUPE_MS) {
      return;
    }

    fetchAgentsPromise = (async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents');
      lastFetchAgentsAt = Date.now();
      set({
        ...applySnapshot(snapshot),
        loading: false,
      });
    } catch (error) {
      set({ loading: false, error: String(error) });
    } finally {
      fetchAgentsPromise = null;
    }
    })();
    return fetchAgentsPromise;
  },

  createAgent: async (name: string, options?: { inheritWorkspace?: boolean }) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>('/api/agents', {
        method: 'POST',
        body: JSON.stringify({ name, inheritWorkspace: options?.inheritWorkspace }),
      });
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgent: async (agentId: string, name: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        {
          method: 'PUT',
          body: JSON.stringify({ name }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  updateAgentModel: async (agentId: string, modelRef: string | null) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/model`,
        {
          method: 'PUT',
          body: JSON.stringify({ modelRef }),
        }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  deleteAgent: async (agentId: string) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  assignChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'PUT' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  removeChannel: async (agentId: string, channelType: ChannelType) => {
    set({ error: null });
    try {
      const snapshot = await hostApiFetch<AgentsSnapshot & { success?: boolean }>(
        `/api/agents/${encodeURIComponent(agentId)}/channels/${encodeURIComponent(channelType)}`,
        { method: 'DELETE' }
      );
      set(applySnapshot(snapshot));
    } catch (error) {
      set({ error: String(error) });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
