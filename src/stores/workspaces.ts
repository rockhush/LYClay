import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { WorkspaceEntry } from '@/types/workspace';

interface WorkspacesState {
  workspaces: WorkspaceEntry[];
  temporaryWorkspaces: WorkspaceEntry[];
  currentWorkspaceId: string | null;
  currentWorkspacePath: string | null;
  loading: boolean;
  error: string | null;
  
  init: () => void;
  setCurrentWorkspace: (workspaceId: string | null) => void;
  setCurrentWorkspacePath: (path: string | null) => void;
  addTemporaryWorkspace: (workspace: WorkspaceEntry) => void;
  removeTemporaryWorkspace: (workspaceId: string) => void;
  refreshWorkspaces: () => void;
  clearError: () => void;
}

export const useWorkspacesStore = create<WorkspacesState>()(
  persist(
    (set, get) => ({
      workspaces: [],
      temporaryWorkspaces: [],
      currentWorkspaceId: null,
      currentWorkspacePath: null,
      loading: false,
      error: null,

      init: () => {
        get().refreshWorkspaces();
      },

      setCurrentWorkspace: (workspaceId: string | null) => {
        if (!workspaceId || workspaceId === 'main') {
          set({ currentWorkspaceId: null, currentWorkspacePath: null });
          return;
        }
        
        const allWorkspaces = [...get().workspaces, ...get().temporaryWorkspaces];
        const workspace = allWorkspaces.find(w => w.id === workspaceId);
        if (!workspace) {
          set({ currentWorkspacePath: null });
          return;
        }
        set({ 
          currentWorkspaceId: workspaceId,
          currentWorkspacePath: workspace.path,
          workspaces: get().workspaces.map(w =>
            w.id === workspaceId
              ? { ...w, lastAccessedAt: Date.now() }
              : w
          ),
          temporaryWorkspaces: get().temporaryWorkspaces.map(w =>
            w.id === workspaceId
              ? { ...w, lastAccessedAt: Date.now() }
              : w
          ),
        });
      },

      setCurrentWorkspacePath: (path: string | null) => {
        set({ currentWorkspacePath: path });
      },

      addTemporaryWorkspace: (workspace: WorkspaceEntry) => {
        set(state => ({
          temporaryWorkspaces: [workspace, ...state.temporaryWorkspaces],
        }));
      },

      removeTemporaryWorkspace: (workspaceId: string) => {
        set(state => ({
          temporaryWorkspaces: state.temporaryWorkspaces.filter(w => w.id !== workspaceId),
          ...(state.currentWorkspaceId === workspaceId
            ? { currentWorkspaceId: null, currentWorkspacePath: null }
            : {}),
        }));
      },

      refreshWorkspaces: () => {
        const currentWorkspaceId = get().currentWorkspaceId;
        const currentWorkspace = get().temporaryWorkspaces.find((workspace) => workspace.id === currentWorkspaceId);
        set({
          // Do not auto-create default/agent workspaces. Large default folders
          // can make the app feel sluggish once the sidebar starts reading them.
          workspaces: [],
          ...(currentWorkspace
            ? { currentWorkspacePath: currentWorkspace.path }
            : { currentWorkspaceId: null, currentWorkspacePath: null }),
        });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'LYClaw-workspaces',
      partialize: (state) => ({
        currentWorkspaceId: state.currentWorkspaceId,
        currentWorkspacePath: state.currentWorkspacePath,
        temporaryWorkspaces: state.temporaryWorkspaces,
      }),
      onRehydrateStorage: () => (state) => {
        state?.refreshWorkspaces();
      },
    }
  )
);
