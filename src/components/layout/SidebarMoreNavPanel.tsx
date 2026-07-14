import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/lib/utils';

export interface SidebarMoreNavItem {
  to: string;
  icon: React.ReactNode;
  label: string;
  testId?: string;
}

interface SidebarMoreNavPanelProps {
  open: boolean;
  anchor: { top: number; left: number } | null;
  onOpenChange: (open: boolean) => void;
  items: SidebarMoreNavItem[];
  menuRef?: React.RefObject<HTMLDivElement | null>;
}

export function SidebarMoreNavPanel({
  open,
  anchor,
  onOpenChange,
  items,
  menuRef,
}: SidebarMoreNavPanelProps) {
  const { pathname } = useLocation();
  const prevPathnameRef = useRef(pathname);

  useEffect(() => {
    if (prevPathnameRef.current === pathname) {
      return;
    }
    prevPathnameRef.current = pathname;
    onOpenChange(false);
  }, [pathname, onOpenChange]);

  if (!open || !anchor) {
    return null;
  }

  return createPortal(
    <div
      ref={menuRef}
      data-testid="sidebar-more-nav-panel"
      style={{
        top: anchor.top,
        left: anchor.left,
      }}
      className="fixed z-[200] w-40 -translate-y-1/2 rounded-xl border border-black/10 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-card"
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          data-testid={item.testId}
          onClick={() => onOpenChange(false)}
          className={({ isActive }) =>
            cn(
              'flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] text-foreground/85 transition-colors hover:bg-black/5 dark:hover:bg-white/10',
              isActive && 'font-medium text-[#FF922B]',
            )
          }
        >
          <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-[#FE7B00]">
            {item.icon}
          </span>
          <span>{item.label}</span>
        </NavLink>
      ))}
    </div>,
    document.body,
  );
}
