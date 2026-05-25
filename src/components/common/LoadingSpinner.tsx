/**
 * Loading Spinner Component
 * Displays a spinning loader animation
 */
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LoadingSpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

/** White circular badge with the standard md spinner (used in chat + skills loading). */
export function LoaderBadge({ className }: { className?: string }) {
  return (
    <div className={cn('rounded-full border border-border bg-background p-2.5 shadow-lg', className)}>
      <LoadingSpinner size="md" />
    </div>
  );
}

interface CenteredLoaderProps {
  message?: string;
  className?: string;
  testId?: string;
}

/** Centered page loading block with unified badge size. */
export function CenteredLoader({ message, className, testId }: CenteredLoaderProps) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center py-20 text-muted-foreground', className)}
      data-testid={testId}
    >
      <LoaderBadge />
      {message ? <p className="mt-4 text-sm">{message}</p> : null}
    </div>
  );
}

export function LoadingSpinner({ size = 'md', className }: LoadingSpinnerProps) {
  return (
    <div className={cn('flex items-center justify-center', className)}>
      <Loader2 className={cn('animate-spin text-primary', sizeClasses[size])} />
    </div>
  );
}

/**
 * Full page loading spinner
 */
export function PageLoader() {
  return (
    <div className="flex h-full items-center justify-center">
      <LoadingSpinner size="lg" />
    </div>
  );
}
