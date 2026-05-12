export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
  modified: number;
}

export interface FileTreeNode extends FileItem {
  children?: FileTreeNode[];
  loaded: boolean;
  expanded: boolean;
  loading: boolean;
  error?: string;
}

export interface FileTreeState {
  treeNodes: Record<string, FileTreeNode>;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  errorPaths: Record<string, string>;
  
  loadDirectory: (dirPath: string) => Promise<void>;
  toggleDirectory: (dirPath: string) => void;
  expandDirectory: (dirPath: string) => void;
  collapseDirectory: (dirPath: string) => void;
  refreshDirectory: (dirPath: string) => Promise<void>;
  clearError: (dirPath: string) => void;
}
