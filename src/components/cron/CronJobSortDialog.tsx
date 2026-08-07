import { useCallback, useEffect, useMemo, useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModalOverlay } from '@/components/ui/modal-overlay';
import { cn } from '@/lib/utils';
import { reorderCronJobIds } from '@/lib/cron-job-order';

const DIALOG_HEIGHT_CLASS = 'h-[660px]';

export type CronJobSortItem = {
  id: string;
  title: string;
};

interface CronJobSortDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: CronJobSortItem[];
  initialOrder: string[];
  title: string;
  subtitle: string;
  hint: string;
  cancelLabel: string;
  confirmLabel: string;
  onConfirm: (order: string[]) => Promise<void> | void;
  maxWidthClass?: string;
  gridColsClass?: string;
  testIdPrefix?: string;
}

export function CronJobSortDialog({
  open,
  onOpenChange,
  items,
  initialOrder,
  title,
  subtitle,
  hint,
  cancelLabel,
  confirmLabel,
  onConfirm,
  maxWidthClass = 'max-w-[500px]',
  gridColsClass = 'grid-cols-2',
  testIdPrefix = 'cron-job-sort',
}: CronJobSortDialogProps) {
  const [draftOrder, setDraftOrder] = useState<string[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const itemById = useMemo(
    () => new Map(items.map((item) => [item.id, item])),
    [items],
  );

  useEffect(() => {
    if (!open) return;
    setDraftOrder(initialOrder.filter((id) => itemById.has(id)));
    setDraggingId(null);
    setSaving(false);
  }, [open, initialOrder, itemById]);

  const handleClose = useCallback(() => {
    if (saving) return;
    onOpenChange(false);
  }, [onOpenChange, saving]);

  const handleConfirm = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onConfirm(draftOrder);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  }, [draftOrder, onConfirm, onOpenChange, saving]);

  const handleReorder = useCallback((fromId: string, toId: string) => {
    setDraftOrder((prev) => reorderCronJobIds(prev, fromId, toId));
  }, []);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape' && !saving) {
      event.preventDefault();
      handleClose();
    }
  }, [handleClose, saving]);

  if (!open) return null;

  const dialogTestId = `${testIdPrefix}-dialog`;
  const titleId = `${testIdPrefix}-dialog-title`;

  return (
    <ModalOverlay
      className="p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={dialogTestId}
      onKeyDown={handleKeyDown}
      zIndexClass="z-[60]"
    >
      <div className={cn(
        'relative flex w-full flex-col rounded-[6px] border-0 bg-white shadow-2xl dark:bg-card overflow-hidden focus:outline-none',
        maxWidthClass,
        DIALOG_HEIGHT_CLASS,
      )}>
        <div className="relative shrink-0 px-6 pt-6 pb-3">
          <h2
            id={titleId}
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
            disabled={saving}
            data-testid={`${testIdPrefix}-close`}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="shrink-0 px-6 pb-3">
          <p className="text-[13px] text-muted-foreground">{hint}</p>
        </div>

        <div className={cn('min-h-0 flex-1 overflow-y-auto px-6 pb-4', saving && 'pointer-events-none opacity-70')}>
          <div className={cn('grid gap-2', gridColsClass)}>
            {draftOrder.map((id) => {
              const item = itemById.get(id);
              if (!item) return null;
              const isDragging = draggingId === id;
              return (
                <div
                  key={id}
                  draggable={!saving}
                  data-testid={`${testIdPrefix}-item-${id}`}
                  onDragStart={(event) => {
                    if (saving) {
                      event.preventDefault();
                      return;
                    }
                    setDraggingId(id);
                    event.dataTransfer.setData('text/plain', id);
                    event.dataTransfer.effectAllowed = 'move';
                  }}
                  onDragEnd={() => {
                    setDraggingId(null);
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    const fromId = draggingId || event.dataTransfer.getData('text/plain');
                    if (!fromId || fromId === id) return;
                    handleReorder(fromId, id);
                    setDraggingId(null);
                  }}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-2.5 py-2 min-h-[36px] select-none transition-colors cursor-grab active:cursor-grabbing',
                    isDragging
                      ? 'border-[#FFD79A]/80 bg-[#FFF7EC]/70 dark:bg-[#FF922B]/10 opacity-80'
                      : 'border-black/[0.06] dark:border-white/10 bg-white/70 dark:bg-white/[0.04] hover:bg-[#FFF7EC]/40 dark:hover:bg-white/[0.06]',
                  )}
                >
                  <GripVertical className="h-3.5 w-3.5 shrink-0 text-[#FF922B]/70 pointer-events-none" />
                  <span
                    className="min-w-0 flex-1 text-[13px] text-foreground truncate pointer-events-none"
                    title={item.title}
                  >
                    {item.title}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="shrink-0 flex items-center justify-end gap-2 border-t border-black/5 px-6 py-4 dark:border-white/10">
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={saving}
            data-testid={`${testIdPrefix}-cancel`}
            className="h-8 rounded-lg px-4 text-[13px] border-black/10 dark:border-white/10"
          >
            {cancelLabel}
          </Button>
          <Button
            onClick={() => void handleConfirm()}
            disabled={saving}
            data-testid={`${testIdPrefix}-confirm`}
            className="h-8 rounded-lg px-4 text-[13px] bg-[#FF922B] hover:bg-[#FE7B00] text-white shadow-sm shadow-[#FF922B]/25"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  );
}
