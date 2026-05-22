import { useState, useRef, useEffect } from 'react';
import { Folder, FolderOpen, Plus, Check, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useWorkspacesStore } from '@/stores/workspaces';
import { useChatStore } from '@/stores/chat';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { WorkspaceEntry } from '@/types/workspace';

interface WorkspacePickerProps {
  disabled?: boolean;
  onWorkspaceChange?: (workspaceId: string | null) => void;
}

export function WorkspacePicker({ disabled = false, onWorkspaceChange }: WorkspacePickerProps) {
  const { t } = useTranslation('common');
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);
  
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const temporaryWorkspaces = useWorkspacesStore((s) => s.temporaryWorkspaces);
  const currentWorkspaceId = useWorkspacesStore((s) => s.currentWorkspaceId);
  const setCurrentWorkspace = useWorkspacesStore((s) => s.setCurrentWorkspace);
  const addTemporaryWorkspace = useWorkspacesStore((s) => s.addTemporaryWorkspace);

  const currentSessionKey = useChatStore((s) => s.currentSessionKey);
  const bindCurrentSessionWorkspace = useChatStore((s) => s.bindCurrentSessionWorkspace);

  const allWorkspaces = [...temporaryWorkspaces, ...workspaces];
  const currentWorkspace = allWorkspaces.find(w => w.id === currentWorkspaceId);

  // 移除自动绑定的useEffect，只在会话内主动选择工作空间时才绑定
  // useEffect(() => {
  //   bindCurrentSessionWorkspace(currentWorkspaceId ?? null);
  // }, [currentWorkspaceId, currentSessionKey, bindCurrentSessionWorkspace]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };

    if (pickerOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [pickerOpen]);

  const handleSelectWorkspace = (workspaceId: string) => {
    setCurrentWorkspace(workspaceId);
    // 只在会话内主动选择工作空间时才绑定
    bindCurrentSessionWorkspace(workspaceId);
    setPickerOpen(false);
    onWorkspaceChange?.(workspaceId);
  };

  const handleOpenFolder = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke('dialog:open', {
        properties: ['openDirectory'],
        title: t('workspace.selectFolder'),
      });
      if (result && !result.canceled && result.filePaths.length > 0) {
        const folderPath = result.filePaths[0];
        const folderName = folderPath.split(/[\\/]/).pop() || 'Workspace';
        
        const newWorkspace: WorkspaceEntry = {
          id: `temp-${Date.now()}`,
          name: folderName,
          agentId: 'temp',
          agentName: folderName,
          path: folderPath,
          createdAt: Date.now(),
          lastAccessedAt: Date.now(),
        };
        
        addTemporaryWorkspace(newWorkspace);
        setCurrentWorkspace(newWorkspace.id);
        // 选择新文件夹时也绑定会话到工作空间
        bindCurrentSessionWorkspace(newWorkspace.id);
        onWorkspaceChange?.(newWorkspace.id);
        
        toast.success(t('workspace.folderSelected', { name: folderName }));
      }
    } catch (error) {
      console.error('Failed to open folder picker:', error);
      toast.error(t('workspace.folderSelectFailed'));
    }
    setPickerOpen(false);
  };

  const currentLabel = currentWorkspace ? currentWorkspace.name : t('workspace.selectWorkspace');

  return (
    <div ref={pickerRef} className="relative shrink-0">
      <Button
        data-testid="workspace-picker-button"
        variant="ghost"
        size="sm"
        className={cn(
          'h-8 max-w-[200px] rounded-lg px-2.5 text-muted-foreground hover:bg-black/5 dark:hover:bg-white/10 hover:text-foreground transition-colors',
          pickerOpen && 'bg-primary/10 text-primary hover:bg-primary/20'
        )}
        onClick={() => setPickerOpen((open) => !open)}
        disabled={disabled}
        title={currentLabel}
      >
        <FolderOpen className="h-3.5 w-3.5 shrink-0" />
        <span className="ml-1.5 truncate text-xs font-medium">{currentLabel}</span>
        <ChevronDown className="ml-1 h-3 w-3 shrink-0 opacity-60" />
      </Button>

      {pickerOpen && (
        <div className="absolute left-0 bottom-full z-20 mb-2 w-72 overflow-hidden rounded-2xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-card">
          <div data-testid="workspace-picker-menu" className="px-3 py-2 text-[11px] font-medium text-muted-foreground/80">
            {t('workspace.pickerTitle')}
          </div>
          
          <div className="max-h-64 overflow-y-auto">
            {allWorkspaces
              .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt)
              .map((workspace) => {
                const displayName = workspace.name;
                const isSelected = currentWorkspaceId === workspace.id;
                return (
                  <button
                    key={workspace.id}
                    onClick={() => handleSelectWorkspace(workspace.id)}
                    className={cn(
                      'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors',
                      'hover:bg-black/5 dark:hover:bg-white/5',
                      isSelected && 'bg-primary/10 text-primary font-medium'
                    )}
                  >
                    <FolderOpen className="h-4 w-4 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium">{displayName}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{workspace.path}</div>
                    </div>
                    {isSelected && <Check className="h-4 w-4 shrink-0" />}
                  </button>
                );
              })}
            {allWorkspaces.length === 0 && (
              <div className="px-3 py-2 text-[12px] text-muted-foreground">
                {t('workspace.noWorkspaceSelected')}
              </div>
            )}
          </div>

          <div className="mt-1.5 border-t border-black/5 pt-1.5 dark:border-white/5">
            <button
              onClick={handleOpenFolder}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors hover:bg-black/5 dark:hover:bg-white/5"
            >
              <Plus className="h-4 w-4 shrink-0" />
              <span className="flex-1">{t('workspace.openLocalFolder')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
