import { memo, type RefObject } from 'react';
import {
  CheckCircle2,
  FolderOutput,
  MoreHorizontal,
  Pin,
  PinOff,
  Pencil,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export interface SidebarSessionRowProps {
  sessionKey: string;
  sessionLabel: string;
  agentName: string;
  isCurrent: boolean;
  isRunning: boolean;
  isPinned: boolean;
  isSessionViewActive: boolean;
  inWorkspace?: boolean;
  firstResponsePreparingLocksSwitch: boolean;
  isMenuOpen: boolean;
  menuAnchor: { top: number; left: number } | null;
  menuRef?: RefObject<HTMLDivElement | null>;
  pinLabel: string;
  statusRunningLabel: string;
  statusCompletedLabel: string;
  sessionActionsLabel: string;
  deleteLabel: string;
  removeFromWorkspaceLabel: string;
  renameLabel: string;
  sessionSwitchBlockedTitle?: string;
  onSelect: (sessionKey: string) => void;
  onMenuToggle: (sessionKey: string, anchor: { top: number; left: number }) => void;
  onMenuClose: () => void;
  onDelete: (sessionKey: string, label: string) => void;
  onRename: (sessionKey: string, label: string) => void;
  onTogglePin: (sessionKey: string) => void;
  onRemoveFromWorkspace?: (sessionKey: string) => void;
}

function SidebarSessionRowComponent({
  sessionKey,
  sessionLabel,
  agentName,
  isCurrent,
  isRunning,
  isPinned,
  isSessionViewActive,
  inWorkspace = false,
  firstResponsePreparingLocksSwitch,
  isMenuOpen,
  menuAnchor,
  menuRef,
  pinLabel,
  statusRunningLabel,
  statusCompletedLabel,
  sessionActionsLabel,
  deleteLabel,
  removeFromWorkspaceLabel,
  renameLabel,
  sessionSwitchBlockedTitle,
  onSelect,
  onMenuToggle,
  onMenuClose,
  onDelete,
  onRename,
  onTogglePin,
  onRemoveFromWorkspace,
}: SidebarSessionRowProps) {
  const statusTitle = isRunning ? statusRunningLabel : statusCompletedLabel;

  return (
    <div className="group relative flex items-center">
      <button
        type="button"
        data-testid={`sidebar-session-${sessionKey}`}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(sessionKey);
        }}
        disabled={firstResponsePreparingLocksSwitch && !isCurrent}
        title={
          firstResponsePreparingLocksSwitch && !isCurrent
            ? sessionSwitchBlockedTitle
            : undefined
        }
        className={cn(
          'w-full text-left rounded-lg py-1.5 text-[13px] transition-[padding,colors]',
          inWorkspace ? 'pl-1.5 pr-1.5 group-hover:pr-7' : 'px-2.5 group-hover:pr-7',
          'hover:bg-white/60 dark:hover:bg-white/10',
          isSessionViewActive && isCurrent
            ? 'bg-white text-[#FF922B] font-medium shadow-sm shadow-black/[0.04] dark:bg-white/10 dark:text-blue-400'
            : 'text-foreground/75',
          firstResponsePreparingLocksSwitch && !isCurrent && 'opacity-50 cursor-not-allowed',
        )}
      >
        <div className={cn('flex min-w-0 items-center', inWorkspace ? 'gap-1.5' : 'gap-2')}>
          <span
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
            title={statusTitle}
            aria-label={statusTitle}
            data-testid={`sidebar-session-status-${sessionKey}`}
            data-status={isRunning ? 'running' : 'completed'}
          >
            {isRunning ? (
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF922B] opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-[#FF922B]" />
              </span>
            ) : (
              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" strokeWidth={2.25} />
            )}
          </span>
          <span className="shrink-0 rounded-full bg-black/[0.14] px-2 py-0.5 text-[10px] font-medium text-foreground/70 dark:bg-white/[0.12]">
            {agentName}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="min-w-0 flex-1 truncate text-left">{sessionLabel}</span>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="center"
              className="max-w-xs whitespace-normal break-words text-[13px]"
            >
              {sessionLabel}
            </TooltipContent>
          </Tooltip>
        </div>
      </button>
      <div
        ref={isMenuOpen ? menuRef : undefined}
        className={cn(
          'absolute right-1 transition-opacity',
          isMenuOpen
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100',
        )}
      >
        <button
          type="button"
          aria-label={sessionActionsLabel}
          aria-expanded={isMenuOpen}
          data-testid={`sidebar-session-menu-${sessionKey}`}
          onClick={(e) => {
            e.stopPropagation();
            if (isMenuOpen) {
              onMenuClose();
              return;
            }
            const rect = e.currentTarget.getBoundingClientRect();
            onMenuToggle(sessionKey, {
              top: rect.top + rect.height / 2,
              left: rect.right + 4,
            });
          }}
          className="flex items-center justify-center rounded p-0.5 text-[#FE7B00] hover:text-[#FE7B00] hover:bg-[#FF922B]/10 dark:text-primary dark:hover:bg-primary/15 transition-colors"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
        {isMenuOpen && menuAnchor ? (
          <div
            data-testid={`sidebar-session-menu-panel-${sessionKey}`}
            style={{
              top: menuAnchor.top,
              left: menuAnchor.left,
            }}
            className="fixed z-50 w-40 -translate-y-1/2 rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-card"
          >
            <button
              type="button"
              aria-label={deleteLabel}
              data-testid={`sidebar-session-delete-${sessionKey}`}
              onClick={(e) => {
                e.stopPropagation();
                onMenuClose();
                onDelete(sessionKey, sessionLabel);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Trash2 className="h-3.5 w-3.5 shrink-0 text-[#FE7B00]" />
              <span>{deleteLabel}</span>
            </button>
            {inWorkspace && onRemoveFromWorkspace ? (
              <button
                type="button"
                aria-label={removeFromWorkspaceLabel}
                data-testid={`sidebar-session-remove-workspace-${sessionKey}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onMenuClose();
                  onRemoveFromWorkspace(sessionKey);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
              >
                <FolderOutput className="h-3.5 w-3.5 shrink-0 text-[#FE7B00]" />
                <span>{removeFromWorkspaceLabel}</span>
              </button>
            ) : null}
            <button
              type="button"
              aria-label={renameLabel}
              data-testid={`sidebar-session-rename-${sessionKey}`}
              onClick={(e) => {
                e.stopPropagation();
                onMenuClose();
                onRename(sessionKey, sessionLabel);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              <Pencil className="h-3.5 w-3.5 shrink-0 text-[#FE7B00]" />
              <span>{renameLabel}</span>
            </button>
            <button
              type="button"
              aria-label={pinLabel}
              data-testid={`sidebar-session-pin-${sessionKey}`}
              onClick={(e) => {
                e.stopPropagation();
                onMenuClose();
                onTogglePin(sessionKey);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            >
              {isPinned ? (
                <PinOff className="h-3.5 w-3.5 shrink-0 text-[#FE7B00]" />
              ) : (
                <Pin className="h-3.5 w-3.5 shrink-0 text-[#FE7B00]" />
              )}
              <span>{pinLabel}</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export const SidebarSessionRow = memo(SidebarSessionRowComponent);
