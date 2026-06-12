import { create } from 'zustand';
import type { FileTreeNode, FileTreeState } from '@/types/file-tree';

export const useFileTreeStore = create<FileTreeState>((set, get) => ({
  treeNodes: {},
  expandedPaths: new Set<string>(),
  loadingPaths: new Set<string>(),
  errorPaths: {},

  loadDirectory: async (dirPath: string) => {
    console.log('[FileTree] Loading directory:', dirPath);
    
    set(state => ({
      loadingPaths: new Set(state.loadingPaths).add(dirPath),
      errorPaths: { ...state.errorPaths, [dirPath]: '' },
    }));

    try {
      const result = await window.electron.ipcRenderer.invoke('fs:readdir', dirPath);
      console.log('[FileTree] IPC result:', result);

      if (result.success) {
        const children: FileTreeNode[] = result.items.map((item: any) => ({
          ...item,
          children: item.isDirectory ? [] : undefined,
          loaded: !item.isDirectory,
          expanded: false,
          loading: false,
        }));

        set(state => ({
          treeNodes: {
            ...state.treeNodes,
            [dirPath]: {
              name: dirPath.split(/[\\/]/).pop() || dirPath,
              path: dirPath,
              isDirectory: true,
              isFile: false,
              size: 0,
              modified: 0,
              children,
              loaded: true,
              expanded: state.expandedPaths.has(dirPath),
              loading: false,
            },
          },
          loadingPaths: new Set([...state.loadingPaths].filter(p => p !== dirPath)),
        }));
      } else {
        console.error('[FileTree] Failed to load directory:', result.error);
        set(state => ({
          errorPaths: { ...state.errorPaths, [dirPath]: result.error || 'Unknown error' },
          loadingPaths: new Set([...state.loadingPaths].filter(p => p !== dirPath)),
        }));
      }
    } catch (error) {
      console.error('[FileTree] Exception loading directory:', error);
      set(state => ({
        errorPaths: { ...state.errorPaths, [dirPath]: String(error) },
        loadingPaths: new Set([...state.loadingPaths].filter(p => p !== dirPath)),
      }));
    }
  },

  toggleDirectory: (dirPath: string) => {
    const state = get();
    if (state.expandedPaths.has(dirPath)) {
      get().collapseDirectory(dirPath);
    } else {
      get().expandDirectory(dirPath);
    }
  },

  expandDirectory: (dirPath: string) => {
    set(state => {
      const newExpanded = new Set(state.expandedPaths).add(dirPath);
      
      if (!state.treeNodes[dirPath]?.loaded) {
        get().loadDirectory(dirPath);
      }

      return {
        expandedPaths: newExpanded,
        treeNodes: {
          ...state.treeNodes,
          [dirPath]: state.treeNodes[dirPath]
            ? { ...state.treeNodes[dirPath], expanded: true }
            : undefined,
        },
      };
    });
  },

  collapseDirectory: (dirPath: string) => {
    set(state => {
      const newExpanded = new Set(state.expandedPaths);
      newExpanded.delete(dirPath);

      return {
        expandedPaths: newExpanded,
        treeNodes: {
          ...state.treeNodes,
          [dirPath]: state.treeNodes[dirPath]
            ? { ...state.treeNodes[dirPath], expanded: false }
            : undefined,
        },
      };
    });
  },

  refreshDirectory: async (dirPath: string) => {
    set(state => ({
      treeNodes: {
        ...state.treeNodes,
        [dirPath]: state.treeNodes[dirPath]
          ? { ...state.treeNodes[dirPath], loaded: false, children: [] }
          : undefined,
      },
    }));

    await get().loadDirectory(dirPath);
  },

  clearError: (dirPath: string) => {
    set(state => ({
      errorPaths: { ...state.errorPaths, [dirPath]: '' },
    }));
  },
}));
