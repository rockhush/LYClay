import { X } from 'lucide-react';
import { toast } from 'sonner';
import type { NewSkillInfo, UpdatableSkillInfo } from '@/lib/skill-update-check';

type StartupSkillNotificationToastProps = {
  toastId: string | number;
  title: string;
  updatable: UpdatableSkillInfo[];
  newSkills: NewSkillInfo[];
  updatePrefix: string;
  newPrefix: string;
};

function NotificationLine({
  variant,
  prefix,
  name,
}: {
  variant: 'update' | 'new';
  prefix: string;
  name: string;
}) {
  const dotClass = variant === 'update'
    ? 'bg-[#FF922B]'
    : 'bg-muted-foreground/35 dark:bg-muted-foreground/50';

  return (
    <div className="flex items-start gap-2 py-1 text-[12px] leading-[18px] text-foreground/90">
      <span className={`mt-[6px] h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} />
      <span className="min-w-0 break-words">
        {prefix}
        {name}
      </span>
    </div>
  );
}

export function StartupSkillNotificationToast({
  toastId,
  title,
  updatable,
  newSkills,
  updatePrefix,
  newPrefix,
}: StartupSkillNotificationToastProps) {
  return (
    <div className="w-[320px] rounded-xl border border-black/[0.08] bg-white p-3 shadow-[0_8px_24px_rgba(15,23,42,0.08)] dark:border-white/10 dark:bg-[hsl(var(--card))]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        <button
          type="button"
          aria-label="Close"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-black/[0.04] hover:text-foreground dark:hover:bg-white/10"
          onClick={() => toast.dismiss(toastId)}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="startup-skill-toast-scroll max-h-[120px] overflow-y-auto overflow-x-hidden">
        {updatable.map((item) => (
          <NotificationLine
            key={`update-${item.slug}`}
            variant="update"
            prefix={updatePrefix}
            name={item.name}
          />
        ))}
        {newSkills.map((item) => (
          <NotificationLine
            key={`new-${item.slug}`}
            variant="new"
            prefix={newPrefix}
            name={item.name}
          />
        ))}
      </div>
    </div>
  );
}
