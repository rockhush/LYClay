import { create } from 'zustand';
import { hostApiFetch } from '@/lib/host-api';
import type {
  InstallDigitalEmployeeInput,
  InstallDigitalEmployeeResult,
  LocalDigitalEmployee,
  UninstallDigitalEmployeeInput,
  UninstallDigitalEmployeeResult,
  UpdateDigitalEmployeeInput,
  UpdateDigitalEmployeeResult,
} from '@/types/digital-employee';
import { useAgentsStore } from './agents';

interface DigitalEmployeesState {
  employees: LocalDigitalEmployee[];
  loading: boolean;
  installingMarketEmployeeId: string | null;
  uninstallingMarketEmployeeId: string | null;
  updatingInstanceId: string | null;
  error: string | null;
  fetchEmployees: () => Promise<void>;
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
  clearError: () => void;
}

export const useDigitalEmployeesStore = create<DigitalEmployeesState>((set, get) => ({
  employees: [],
  loading: false,
  installingMarketEmployeeId: null,
  uninstallingMarketEmployeeId: null,
  updatingInstanceId: null,
  error: null,

  fetchEmployees: async () => {
    set({ loading: true, error: null });
    try {
      const employees = await hostApiFetch<LocalDigitalEmployee[]>('/api/digital-employees');
      set({ employees, loading: false });
    } catch (error) {
      set({ loading: false, error: String(error) });
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

  clearError: () => set({ error: null }),
}));
