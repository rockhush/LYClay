import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import {
  commitCachedDigitalEmployeeDisplayMetadata,
  seedCachedDigitalEmployeeDisplayMetadata,
} from '@/lib/digital-employee-display-cache';
import {
  retireDigitalEmployee,
  retireDigitalEmployeesByMarketId,
  unretireDigitalEmployee,
  unretireDigitalEmployeesByMarketId,
  refreshRetiredDigitalEmployeeNamesForMarketId,
} from '@/lib/retired-digital-employees';
import { scheduleUiStateSync } from '@/lib/ui-state-persistence';
import type {
  InstallDigitalEmployeeInput,
  InstallDigitalEmployeeResult,
  LocalDigitalEmployee,
  SetDigitalEmployeeEnabledResult,
  UninstallDigitalEmployeeInput,
  UninstallDigitalEmployeeResult,
  UpdateDigitalEmployeeInput,
  UpdateDigitalEmployeeResult,
} from '@/types/digital-employee';
import { useAgentsStore } from './agents';

export interface DigitalEmployeeMarketplaceEntry {
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string;
  downloads: number;
  updateTime: string;
  category: string;
  installed: boolean;
  tags: string[];
}

interface DigitalEmployeesState {
  employees: LocalDigitalEmployee[];
  marketplaceCatalog: DigitalEmployeeMarketplaceEntry[];
  loading: boolean;
  marketplaceCatalogLoading: boolean;
  installingMarketEmployeeId: string | null;
  uninstallingMarketEmployeeId: string | null;
  updatingInstanceId: string | null;
  error: string | null;
  /** Bumped when retired-session registry changes so chat UI can re-evaluate read-only state. */
  retiredSessionsRevision: number;
  fetchEmployees: () => Promise<void>;
  prefetchMarketplaceCatalog: () => Promise<void>;
  installMarketplaceEmployee: (
    input: InstallDigitalEmployeeInput,
  ) => Promise<InstallDigitalEmployeeResult>;
  uninstallMarketplaceEmployee: (
    input: UninstallDigitalEmployeeInput,
  ) => Promise<UninstallDigitalEmployeeResult>;
  updateEmployee: (
    instanceId: string,
    input: UpdateDigitalEmployeeInput,
  ) => Promise<UpdateDigitalEmployeeResult>;
  setEmployeeEnabled: (instanceId: string, enabled: boolean) => Promise<void>;
  clearError: () => void;
}

function seedMarketplaceCatalogCache(entries: DigitalEmployeeMarketplaceEntry[]): void {
  let dirty = false;
  for (const entry of entries) {
    if (seedCachedDigitalEmployeeDisplayMetadata(entry.slug, {
      version: entry.version,
      name: entry.name,
      author: entry.author,
      description: entry.description,
      updateTime: entry.updateTime,
      tags: entry.tags,
    })) {
      dirty = true;
    }
  }
  if (dirty) {
    scheduleUiStateSync();
  }
}

export const useDigitalEmployeesStore = create<DigitalEmployeesState>((set, get) => ({
  employees: [],
  marketplaceCatalog: [],
  loading: false,
  marketplaceCatalogLoading: false,
  installingMarketEmployeeId: null,
  uninstallingMarketEmployeeId: null,
  updatingInstanceId: null,
  error: null,
  retiredSessionsRevision: 0,

  fetchEmployees: async () => {
    set({ loading: true, error: null });
    try {
      const employees = await hostApiFetch<LocalDigitalEmployee[]>('/api/digital-employees');
      set({ employees, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
    }
  },

  prefetchMarketplaceCatalog: async () => {
    set({ marketplaceCatalogLoading: true });
    try {
      const result = await hostApiFetch<{
        success: boolean;
        results?: DigitalEmployeeMarketplaceEntry[];
        error?: string;
      }>('/api/digital-employee/marketplace/list', {
        method: 'POST',
        body: JSON.stringify({
          query: '',
          category: '',
          sort: '-download_count',
        }),
      });
      if (!result.success) {
        throw new Error(result.error || 'Failed to prefetch digital employee marketplace catalog');
      }
      const marketplaceCatalog = result.results || [];
      seedMarketplaceCatalogCache(marketplaceCatalog);
      set({ marketplaceCatalog, marketplaceCatalogLoading: false });
    } catch (error) {
      console.warn('[Digital Employees Store] Prefetch marketplace catalog failed (non-fatal):', error);
      set({ marketplaceCatalogLoading: false });
    }
  },

  installMarketplaceEmployee: async (input) => {
    set({ installingMarketEmployeeId: String(input.marketEmployeeId), error: null });
    try {
      const result = await hostApiFetch<InstallDigitalEmployeeResult>(
        '/api/digital-employees/install',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      );
      const marketplaceEntry = get().marketplaceCatalog.find(
        (entry) => entry.slug === String(input.marketEmployeeId),
      );
      if (marketplaceEntry) {
        commitCachedDigitalEmployeeDisplayMetadata(marketplaceEntry.slug, {
          version: marketplaceEntry.version,
          name: marketplaceEntry.name,
          author: marketplaceEntry.author,
          description: marketplaceEntry.description,
          updateTime: marketplaceEntry.updateTime,
          tags: marketplaceEntry.tags,
        });
      }
      let reactivatedRetiredSessions = unretireDigitalEmployeesByMarketId(input.marketEmployeeId);
      if (marketplaceEntry?.name) {
        if (refreshRetiredDigitalEmployeeNamesForMarketId(input.marketEmployeeId, marketplaceEntry.name)) {
          reactivatedRetiredSessions = true;
        }
      }
      if (result.agentId && unretireDigitalEmployee(result.agentId)) {
        reactivatedRetiredSessions = true;
      }
      if (reactivatedRetiredSessions) {
        set((state) => ({ retiredSessionsRevision: state.retiredSessionsRevision + 1 }));
        scheduleUiStateSync();
      }
      await Promise.all([
        get().fetchEmployees(),
        useAgentsStore.getState().fetchAgents({ force: true }),
      ]);
      set({ installingMarketEmployeeId: null });
      return result;
    } catch (error) {
      set({ installingMarketEmployeeId: null, error: String(error) });
      throw error;
    }
  },

  uninstallMarketplaceEmployee: async (input) => {
    const marketEmployeeId = input.marketEmployeeId != null
      ? String(input.marketEmployeeId)
      : null;
    const employeesBeforeUninstall = get().employees.filter((employee) => {
      if (input.instanceId) {
        return employee.instanceId === input.instanceId;
      }
      if (marketEmployeeId) {
        return employee.marketEmployeeId === marketEmployeeId;
      }
      return false;
    });
    set({
      uninstallingMarketEmployeeId: marketEmployeeId,
      error: null,
    });
    try {
      const result = await hostApiFetch<UninstallDigitalEmployeeResult>(
        '/api/digital-employees/uninstall',
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      );
      let retiredChanged = false;
      const retiredAt = new Date().toISOString();
      const marketIdsToRetireAll = new Set<string>();
      for (const employee of employeesBeforeUninstall) {
        if (employee.marketEmployeeId) {
          marketIdsToRetireAll.add(employee.marketEmployeeId);
        }
        if (retireDigitalEmployee({
          agentId: employee.agentId,
          name: employee.name,
          marketEmployeeId: employee.marketEmployeeId,
          retiredAt,
        })) {
          retiredChanged = true;
        }
      }
      if (
        employeesBeforeUninstall.length === 0
        && result.agentId
        && result.marketEmployeeId
      ) {
        marketIdsToRetireAll.add(String(result.marketEmployeeId));
        const marketplaceEntry = get().marketplaceCatalog.find(
          (entry) => entry.slug === result.marketEmployeeId,
        );
        if (retireDigitalEmployee({
          agentId: result.agentId,
          name: marketplaceEntry?.name || result.agentId,
          marketEmployeeId: result.marketEmployeeId,
          retiredAt,
        })) {
          retiredChanged = true;
        }
      }
      for (const marketId of marketIdsToRetireAll) {
        if (retireDigitalEmployeesByMarketId(marketId, { retiredAt })) {
          retiredChanged = true;
        }
      }
      if (retiredChanged) {
        set((state) => ({ retiredSessionsRevision: state.retiredSessionsRevision + 1 }));
        scheduleUiStateSync();
      }
      await Promise.all([
        get().fetchEmployees(),
        useAgentsStore.getState().fetchAgents({ force: true }),
      ]);
      set({ uninstallingMarketEmployeeId: null });
      return result;
    } catch (error) {
      set({ uninstallingMarketEmployeeId: null, error: String(error) });
      throw error;
    }
  },

  updateEmployee: async (instanceId, input) => {
    set({ updatingInstanceId: instanceId, error: null });
    try {
      const result = await hostApiFetch<UpdateDigitalEmployeeResult>(
        `/api/digital-employees/${encodeURIComponent(instanceId)}/update`,
        {
          method: 'POST',
          body: JSON.stringify(input),
        },
      );
      const employee = get().employees.find((entry) => entry.instanceId === instanceId);
      const marketplaceEntry = employee
        ? get().marketplaceCatalog.find((entry) => entry.slug === employee.marketEmployeeId)
        : undefined;
      if (marketplaceEntry) {
        commitCachedDigitalEmployeeDisplayMetadata(marketplaceEntry.slug, {
          version: marketplaceEntry.version,
          name: marketplaceEntry.name,
          author: marketplaceEntry.author,
          description: marketplaceEntry.description,
          updateTime: marketplaceEntry.updateTime,
          tags: marketplaceEntry.tags,
        });
      }
      await Promise.all([
        get().fetchEmployees(),
        useAgentsStore.getState().fetchAgents({ force: true }),
      ]);
      set({ updatingInstanceId: null });
      return result;
    } catch (error) {
      set({ updatingInstanceId: null, error: String(error) });
      throw error;
    }
  },

  setEmployeeEnabled: async (instanceId, enabled) => {
    const previous = get().employees.find((employee) => employee.instanceId === instanceId);
    set((state) => ({
      employees: state.employees.map((employee) => (
        employee.instanceId === instanceId ? { ...employee, enabled } : employee
      )),
      error: null,
    }));
    try {
      const result = await hostApiFetch<SetDigitalEmployeeEnabledResult>(
        `/api/digital-employees/${encodeURIComponent(instanceId)}/enabled`,
        {
          method: 'PUT',
          body: JSON.stringify({ enabled }),
        },
      );
      if (!result.success) {
        throw new Error('Failed to update digital employee status');
      }
      set((state) => ({
        employees: state.employees.map((employee) => (
          employee.instanceId === instanceId
            ? { ...employee, enabled: result.enabled }
            : employee
        )),
      }));
    } catch (error) {
      if (previous) {
        set((state) => ({
          employees: state.employees.map((employee) => (
            employee.instanceId === instanceId
              ? { ...employee, enabled: previous.enabled }
              : employee
          )),
          error: String(error),
        }));
      }
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));

/** Load installed employees and marketplace metadata on app startup. */
let startupDigitalEmployeesFetchHooked = false;
function ensureStartupDigitalEmployeesFetch(): void {
  if (startupDigitalEmployeesFetchHooked) return;
  startupDigitalEmployeesFetchHooked = true;
  void useDigitalEmployeesStore.getState().fetchEmployees();
  void useDigitalEmployeesStore.getState().prefetchMarketplaceCatalog();
}
ensureStartupDigitalEmployeesFetch();
