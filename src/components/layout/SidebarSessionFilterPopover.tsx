import { type RefObject } from 'react';
import { cn } from '@/lib/utils';
import type { SidebarSessionCategoryFilter } from '@/lib/session-category-filter';

export interface SidebarSessionFilterPopoverLabels {
  category: string;
  all: string;
  cron: string;
  session: string;
}

interface SidebarSessionFilterPopoverProps {
  open: boolean;
  anchor: { top: number; left: number } | null;
  value: SidebarSessionCategoryFilter;
  panelRef?: RefObject<HTMLDivElement | null>;
  labels: SidebarSessionFilterPopoverLabels;
  onChange: (value: SidebarSessionCategoryFilter) => void;
}

const CATEGORY_OPTIONS: Array<{ value: SidebarSessionCategoryFilter; labelKey: keyof SidebarSessionFilterPopoverLabels }> = [
  { value: 'all', labelKey: 'all' },
  { value: 'cron', labelKey: 'cron' },
  { value: 'session', labelKey: 'session' },
];

const OPTION_ROW_CLASS = 'flex h-9 items-center px-3 text-left text-[13px] leading-none';

export function SidebarSessionFilterPopover({
  open,
  anchor,
  value,
  panelRef,
  labels,
  onChange,
}: SidebarSessionFilterPopoverProps) {
  if (!open || !anchor) return null;

  return (
    <div
      ref={panelRef}
      data-testid="sidebar-session-filter-panel"
      style={{ top: anchor.top, left: anchor.left }}
      className="fixed z-50 w-[220px] overflow-hidden rounded-xl bg-white shadow-[0_4px_16px_rgba(15,23,42,0.10)] dark:bg-card dark:shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
    >
      <div className="flex">
        <div className="flex w-[72px] shrink-0 flex-col self-stretch bg-black/[0.04] dark:bg-white/10">
          <div
            data-testid="sidebar-session-filter-category-tab"
            className="flex h-9 items-center px-3"
          >
            <span className="-mt-px text-[12px] font-medium leading-none text-foreground/85">
              {labels.category}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          {CATEGORY_OPTIONS.map((option) => {
            const selected = value === option.value;
            return (
              <button
                key={option.value}
                type="button"
                data-testid={`sidebar-session-filter-option-${option.value}`}
                onClick={() => onChange(option.value)}
                className={cn(
                  OPTION_ROW_CLASS,
                  'transition-colors',
                  selected
                    ? 'bg-black/[0.04] font-medium text-[#FF922B] dark:bg-white/10 dark:text-[#FF922B]'
                    : 'text-foreground/80 hover:bg-black/[0.03] dark:hover:bg-white/5',
                )}
              >
                {labels[option.labelKey]}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
