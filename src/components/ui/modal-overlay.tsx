import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

export interface ModalOverlayProps extends React.HTMLAttributes<HTMLDivElement> {
  zIndexClass?: string;
}

/**
 * Full-viewport modal backdrop rendered via portal so overlays cover the
 * title bar and are not clipped by scrollable main content.
 */
export function ModalOverlay({
  className,
  zIndexClass = 'z-50',
  children,
  ...props
}: ModalOverlayProps) {
  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center bg-black/50',
        zIndexClass,
        className,
      )}
      {...props}
    >
      {children}
    </div>,
    document.body,
  );
}
