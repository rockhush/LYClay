import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { cn } from '@/lib/utils';

const BATCH_SELECT_DIALOG_HEIGHT_CLASS = 'h-[560px]';

const SKILL_ICON_COLOR = 'bg-[#FF922B]';

function getSkillInitial(name: string): string {
  if (!name) return 'S';
  const trimmed = name.trim();
  const firstChar = trimmed.charAt(0).toUpperCase();
  return firstChar.match(/[A-Za-z一-龥]/) ? firstChar : 'S';
}

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

export type BatchSelectSkillItem = {
  key: string;
  name: string;
  versionLabel: string;
};

export interface BatchSelectSkillsDialogProps {
  open: boolean;
  dialogId: string;
  title: string;
  subtitle: string;
  progressText?: string;
  selectAllLabel: string;
  selectAllAria: string;
  deselectAllAria: string;
  cancelLabel: string;
  confirmLabel: string;
  items: BatchSelectSkillItem[];
  onOpenChange: (open: boolean) => void;
  onConfirm: (selectedKeys: string[]) => void;
  onEmptySelection?: () => void;
  busy?: boolean;
  progress?: { current: number; total: number } | null;
}

export function BatchSelectSkillsDialog({
  open,
  dialogId,
  title,
  subtitle,
  progressText,
  selectAllLabel,
  selectAllAria,
  deselectAllAria,
  cancelLabel,
  confirmLabel,
  items,
  onOpenChange,
  onConfirm,
  onEmptySelection,
  busy = false,
  progress = null,
}: BatchSelectSkillsDialogProps) {
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open) return;
    setSelectedKeys(new Set());
  }, [open]);

  const allSelected = useMemo(
    () => items.length > 0 && items.every((item) => selectedKeys.has(item.key)),
    [items, selectedKeys],
  );

  const toggleSelectAll = useCallback(() => {
    if (busy) return;
    if (allSelected) {
      setSelectedKeys(new Set());
      return;
    }
    setSelectedKeys(new Set(items.map((item) => item.key)));
  }, [allSelected, busy, items]);

  const toggleItem = useCallback((key: string) => {
    if (busy) return;
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [busy]);

  const handleClose = useCallback(() => {
    if (busy) return;
    onOpenChange(false);
  }, [busy, onOpenChange]);

  const handleConfirm = useCallback(() => {
    if (busy) return;
    if (selectedKeys.size === 0) {
      onEmptySelection?.();
      return;
    }
    onConfirm(Array.from(selectedKeys));
  }, [busy, onConfirm, onEmptySelection, selectedKeys]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleClose();
    }
  }, [handleClose]);

  if (!open) return null;

  return (
    <ModalOverlay
      className="p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={dialogId}
      onKeyDown={handleKeyDown}
      zIndexClass="z-[60]"
    >
      <div className={cn(
        'relative flex w-full max-w-[500px] flex-col rounded-[6px] border-0 bg-white shadow-2xl dark:bg-card overflow-hidden focus:outline-none',
        BATCH_SELECT_DIALOG_HEIGHT_CLASS,
      )}>
        <div className="relative shrink-0 px-6 pt-6 pb-3">
          <h2
            id={dialogId}
            className="!text-[16px] font-sans font-bold text-foreground leading-tight tracking-normal"
          >
            {title}
          </h2>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {busy && progress && progressText
              ? progressText
              : subtitle}
          </p>
          <Button
            variant="ghost"
            size="icon"
            className="absolute right-4 top-4 h-8 w-8 rounded-full text-muted-foreground hover:bg-black/5 hover:text-foreground dark:hover:bg-white/5"
            onClick={handleClose}
            disabled={busy}
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

        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-4', busy && 'pointer-events-none opacity-70')}>
          <div className="grid grid-cols-2 gap-3">
            {items.map((item) => {
              const checked = selectedKeys.has(item.key);
              return (
                <div
                  key={item.key}
                  role="button"
                  tabIndex={busy ? -1 : 0}
                  onClick={() => toggleItem(item.key)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleItem(item.key);
                    }
                  }}
                  className={cn(
                    'flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer transition-colors',
                    checked
                      ? 'border-[#FFD79A]/80 bg-[#FFF7EC]/70 dark:bg-[#FF922B]/10'
                      : 'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04] hover:bg-[#FFF7EC]/40 dark:hover:bg-white/[0.06]',
                  )}
                >
                  <OrangeCheckbox
                    checked={checked}
                    onChange={() => toggleItem(item.key)}
                    className="shrink-0 pointer-events-none"
                    aria-label={item.name}
                  />
                  <div
                    className={cn(
                      'w-7 h-7 shrink-0 flex items-center justify-center text-[12px] font-semibold text-white rounded-lg overflow-hidden',
                      SKILL_ICON_COLOR,
                    )}
                  >
                    {getSkillInitial(item.name)}
                  </div>
                  <div className="min-w-0 flex-1 self-center">
                    <p className="text-[14px] font-normal text-foreground truncate">{item.name}</p>
                    <p className="text-[11px] font-mono text-muted-foreground/70">{item.versionLabel}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-black/5 px-6 py-4 dark:border-white/10">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={busy}
            className="h-8 rounded-lg px-4 text-[13px] border-black/10 dark:border-white/10"
          >
            {cancelLabel}
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={busy || selectedKeys.size === 0}
            className="h-8 rounded-lg px-4 text-[13px] bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm shadow-[#FF922B]/25"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
