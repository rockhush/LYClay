import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import {
  flattenBatchDeleteSessionGroups,
  type BatchDeleteSessionGroup,
} from '@/lib/session-batch-delete-groups';
import { cn } from '@/lib/utils';

const DIALOG_HEIGHT_CLASS = 'h-[560px]';

const ORANGE_CHECKBOX_CLASS =
  'inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border border-[#FF922B] bg-white transition-colors';

function OrangeCheckbox({
  checked,
  onChange,
  className,
  'aria-label': ariaLabel,
}: {
  checked: boolean;
  onChange: () => void;
  className?: string;
  'aria-label'?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={(event) => {
        event.stopPropagation();
        onChange();
      }}
      className={cn(ORANGE_CHECKBOX_CLASS, className)}
    >
      {checked ? <Check className="h-3 w-3 text-[#FF922B]" strokeWidth={3} /> : null}
    </button>
  );
}

interface BatchDeleteSessionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groups: BatchDeleteSessionGroup[];
  title: string;
  subtitle: string;
  selectAllLabel: string;
  selectAllAria: string;
  deselectAllAria: string;
  cancelLabel: string;
  deleteLabel: string;
  confirmTitle: string;
  confirmMessage: string;
  emptySelectionMessage: string;
  onDelete: (sessionKeys: string[]) => Promise<void>;
}

export function BatchDeleteSessionsDialog({
  open,
  onOpenChange,
  groups,
  title,
  subtitle,
  selectAllLabel,
  selectAllAria,
  deselectAllAria,
  cancelLabel,
  deleteLabel,
  confirmTitle,
  confirmMessage,
  emptySelectionMessage,
  onDelete,
}: BatchDeleteSessionsDialogProps) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const allItems = useMemo(() => flattenBatchDeleteSessionGroups(groups), [groups]);

  useEffect(() => {
    if (!open) return;
    setSelectedKeys(new Set());
    setConfirmOpen(false);
    setDeleting(false);
  }, [open]);

  const allSelected = useMemo(
    () => allItems.length > 0 && allItems.every((item) => selectedKeys.has(item.key)),
    [allItems, selectedKeys],
  );

  const toggleSelectAll = useCallback(() => {
    if (deleting) return;
    if (allSelected) {
      setSelectedKeys(new Set());
      return;
    }
    setSelectedKeys(new Set(allItems.map((item) => item.key)));
  }, [allItems, allSelected, deleting]);

  const toggleItem = useCallback((key: string) => {
    if (deleting) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [deleting]);

  const handleClose = useCallback(() => {
    if (deleting) return;
    onOpenChange(false);
  }, [deleting, onOpenChange]);

  const handleDeleteClick = useCallback(() => {
    if (deleting) return;
    if (selectedKeys.size === 0) {
      return;
    }
    setConfirmOpen(true);
  }, [deleting, selectedKeys.size]);

  const handleConfirmDelete = useCallback(async () => {
    if (deleting || selectedKeys.size === 0) return;
    setDeleting(true);
    try {
      await onDelete(Array.from(selectedKeys));
      setConfirmOpen(false);
      onOpenChange(false);
    } finally {
      setDeleting(false);
    }
  }, [deleting, onDelete, onOpenChange, selectedKeys]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !deleting && !confirmOpen) {
      event.preventDefault();
      handleClose();
    }
  }, [confirmOpen, deleting, handleClose]);

  if (!open) return null;

  return (
    <>
      <ModalOverlay
        className="p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-delete-sessions-dialog-title"
        data-testid="batch-delete-sessions-dialog"
        onKeyDown={handleKeyDown}
        zIndexClass="z-[60]"
      >
        <div className={cn(
          'relative flex w-full max-w-[500px] flex-col rounded-[6px] border-0 bg-white shadow-2xl dark:bg-card overflow-hidden focus:outline-none',
          DIALOG_HEIGHT_CLASS,
        )}>
          <div className="relative shrink-0 px-6 pt-6 pb-3">
            <h2
              id="batch-delete-sessions-dialog-title"
              className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal"
            >
              {title}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4 h-8 w-8 rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
              onClick={handleClose}
              disabled={deleting}
              data-testid="batch-delete-sessions-close"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="shrink-0 px-6 pb-3 flex items-center gap-2">
            <span className="text-[13px] text-foreground">{selectAllLabel}</span>
            <OrangeCheckbox
              checked={allSelected}
              onChange={toggleSelectAll}
              aria-label={allSelected ? deselectAllAria : selectAllAria}
            />
          </div>

          <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-4', deleting && 'pointer-events-none opacity-70')}>
            {groups.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">{emptySelectionMessage}</p>
            ) : (
              <div className="space-y-4">
                {groups.map((group) => (
                  <div key={group.id} data-testid={`batch-delete-group-${group.id}`}>
                    <div className="mb-2 text-[11px] font-medium text-muted-foreground/80 tracking-tight">
                      {group.label}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {group.sessions.map((session) => {
                        const checked = selectedKeys.has(session.key);
                        return (
                          <div
                            key={session.key}
                            role="button"
                            tabIndex={deleting ? -1 : 0}
                            data-testid={`batch-delete-session-${session.key}`}
                            onClick={() => toggleItem(session.key)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                toggleItem(session.key);
                              }
                            }}
                            className={cn(
                              'flex items-center gap-2 rounded-lg border px-2.5 py-2 cursor-pointer transition-colors min-h-[36px]',
                              checked
                                ? 'border-[#FFD79A]/80 bg-[#FFF7EC]/70 dark:bg-[#FF922B]/10'
                                : 'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04] hover:bg-[#FFF7EC]/40 dark:hover:bg-white/[0.06]',
                            )}
                          >
                            <OrangeCheckbox
                              checked={checked}
                              onChange={() => toggleItem(session.key)}
                              className="pointer-events-none"
                              aria-label={session.title}
                            />
                            <span className="min-w-0 flex-1 text-[13px] text-foreground truncate" title={session.title}>
                              {session.title}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="shrink-0 flex items-center justify-end gap-2 border-t border-black/5 px-6 py-4 dark:border-white/10">
            <Button
              variant="outline"
              onClick={handleClose}
              disabled={deleting}
              data-testid="batch-delete-sessions-cancel"
              className="h-8 rounded-lg px-4 text-[13px] border-black/10 dark:border-white/10"
            >
              {cancelLabel}
            </Button>
            <Button
              onClick={handleDeleteClick}
              disabled={deleting || selectedKeys.size === 0}
              data-testid="batch-delete-sessions-delete"
              className="h-8 rounded-lg px-4 text-[13px] bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm shadow-[#FF922B]/25"
            >
              {deleteLabel}
            </Button>
          </div>
        </div>
      </ModalOverlay>

      <ConfirmDialog
        open={confirmOpen}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={deleteLabel}
        cancelLabel={cancelLabel}
        variant="destructive"
        testId="batch-delete-sessions-confirm"
        zIndexClass="z-[70]"
        onConfirm={handleConfirmDelete}
        onCancel={() => {
          if (deleting) return;
          setConfirmOpen(false);
        }}
      />
    </>
  );
}
