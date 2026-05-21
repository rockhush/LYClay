import { useEffect, useState } from 'react';
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFileTreeStore } from '@/stores/file-tree';
import type { FileTreeNode } from '@/types/file-tree';

interface FileTreeProps {
  rootPath: string;
  rootName: string;
  depth?: number;
}

export function FileTree({ rootPath, rootName, depth = 0 }: FileTreeProps) {
  const treeNodes = useFileTreeStore((s) => s.treeNodes);
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const loadingPaths = useFileTreeStore((s) => s.loadingPaths);
  const errorPaths = useFileTreeStore((s) => s.errorPaths);
  const loadDirectory = useFileTreeStore((s) => s.loadDirectory);
  const toggleDirectory = useFileTreeStore((s) => s.toggleDirectory);
  const refreshDirectory = useFileTreeStore((s) => s.refreshDirectory);
  const clearError = useFileTreeStore((s) => s.clearError);

  const node = treeNodes[rootPath];
  const isExpanded = expandedPaths.has(rootPath);
  const isLoading = loadingPaths.has(rootPath);
  const error = errorPaths[rootPath];

  // 只在用户点击展开时才加载目录内容
  const handleToggle = () => {
    if (error) {
      clearError(rootPath);
    }
    if (!isExpanded && !node?.loaded && !isLoading) {
      loadDirectory(rootPath);
    }
    toggleDirectory(rootPath);
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    refreshDirectory(rootPath);
  };

  return (
    <div className="select-none">
      <div
        className={cn(
          'flex items-center gap-1 rounded-md px-1 py-1 text-[12px] cursor-pointer transition-colors',
          'hover:bg-black/5 dark:hover:bg-white/5',
          isExpanded && 'bg-black/5 dark:bg-white/5',
        )}
        onClick={handleToggle}
      >
        <div className="flex shrink-0 items-center justify-center w-4 h-4">
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          ) : error ? (
            <AlertCircle className="h-3 w-3 text-destructive" />
          ) : (
            <ChevronRight
              className={cn(
                'h-3 w-3 text-muted-foreground transition-transform',
                isExpanded && 'rotate-90',
              )}
            />
          )}
        </div>

        <div className="flex shrink-0 items-center justify-center w-4 h-4">
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-amber-500" />
          )}
        </div>

        <span className="truncate flex-1 text-foreground/80">{rootName}</span>

        {error && (
          <button
            className="ml-1 p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
            onClick={handleRefresh}
            title="Refresh"
          >
            <Loader2 className="h-3 w-3" />
          </button>
        )}
      </div>

      {isExpanded && node?.children && (
        <div className="ml-4">
          {node.children.map((child) => (
            <FileTreeNode key={child.path} node={child} depth={depth + 1} />
          ))}
        </div>
      )}

      {isExpanded && isLoading && !node?.children && (
        <div className="ml-8 py-1 text-[11px] text-muted-foreground">
          Loading...
        </div>
      )}

      {isExpanded && error && !isLoading && (
        <div className="ml-8 py-1 text-[11px] text-destructive">
          {error || 'Failed to load directory'}
        </div>
      )}
    </div>
  );
}

interface FileTreeNodeProps {
  node: FileTreeNode;
  depth: number;
}

function FileTreeNode({ node, depth }: FileTreeNodeProps) {
  const expandedPaths = useFileTreeStore((s) => s.expandedPaths);
  const loadingPaths = useFileTreeStore((s) => s.loadingPaths);
  const errorPaths = useFileTreeStore((s) => s.errorPaths);
  const toggleDirectory = useFileTreeStore((s) => s.toggleDirectory);
  const loadDirectory = useFileTreeStore((s) => s.loadDirectory);
  const treeNodes = useFileTreeStore((s) => s.treeNodes);
  const clearError = useFileTreeStore((s) => s.clearError);
  const refreshDirectory = useFileTreeStore((s) => s.refreshDirectory);

  const isExpanded = expandedPaths.has(node.path);
  const isLoading = loadingPaths.has(node.path);
  const error = errorPaths[node.path];
  const childNode = treeNodes[node.path];

  const handleToggle = () => {
    if (node.isDirectory) {
      if (error) {
        clearError(node.path);
      }
      toggleDirectory(node.path);
    }
  };

  const handleRefresh = (e: React.MouseEvent) => {
    e.stopPropagation();
    refreshDirectory(node.path);
  };

  const handleOpen = () => {
    if (node.isFile) {
      window.electron.ipcRenderer.invoke('shell:openPath', node.path);
    }
  };

  const handleShowInFolder = (e: React.MouseEvent) => {
    e.stopPropagation();
    window.electron.ipcRenderer.invoke('shell:showItemInFolder', node.path);
  };

  if (node.isDirectory) {
    return (
      <div className="select-none">
        <div
          className={cn(
            'flex items-center gap-1 rounded-md px-1 py-1 text-[12px] cursor-pointer transition-colors',
            'hover:bg-black/5 dark:hover:bg-white/5',
            isExpanded && 'bg-black/5 dark:bg-white/5',
          )}
          onClick={handleToggle}
        >
          <div className="flex shrink-0 items-center justify-center w-4 h-4">
            {isLoading ? (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            ) : error ? (
              <AlertCircle className="h-3 w-3 text-destructive" />
            ) : (
              <ChevronRight
                className={cn(
                  'h-3 w-3 text-muted-foreground transition-transform',
                  isExpanded && 'rotate-90',
                )}
              />
            )}
          </div>

          <div className="flex shrink-0 items-center justify-center w-4 h-4">
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 text-amber-500" />
            ) : (
              <Folder className="h-3.5 w-3.5 text-amber-500" />
            )}
          </div>

          <span className="truncate flex-1 text-foreground/80">{node.name}</span>

          {error && (
            <button
              className="ml-1 p-0.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive"
              onClick={handleRefresh}
              title="Refresh"
            >
              <Loader2 className="h-3 w-3" />
            </button>
          )}
        </div>

        {isExpanded && childNode?.children && (
          <div className="ml-4">
            {childNode.children.map((child) => (
              <FileTreeNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </div>
        )}

        {isExpanded && isLoading && !childNode?.children && (
          <div className="ml-8 py-1 text-[11px] text-muted-foreground">
            Loading...
          </div>
        )}

        {isExpanded && error && !isLoading && (
          <div className="ml-8 py-1 text-[11px] text-destructive">
            {error || 'Failed to load directory'}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded-md px-1 py-1 text-[12px] cursor-pointer transition-colors',
        'hover:bg-black/5 dark:hover:bg-white/5',
      )}
      onClick={handleOpen}
      onContextMenu={handleShowInFolder}
    >
      <div className="w-4 h-4" />

      <div className="flex shrink-0 items-center justify-center w-4 h-4">
        <File className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      <span className="truncate flex-1 text-foreground/70">{node.name}</span>
    </div>
  );
}
