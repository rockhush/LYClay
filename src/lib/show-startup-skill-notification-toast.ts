import { createElement } from 'react';
import type { TFunction } from 'i18next';
import { toast } from 'sonner';
import { StartupSkillNotificationToast } from '@/components/skills/StartupSkillNotificationToast';
import type { NewSkillInfo, UpdatableSkillInfo } from '@/lib/skill-update-check';

export const STARTUP_SKILL_NOTIFICATION_TOAST_ID = 'startup-skill-notification';

export function showStartupSkillNotificationToast(
  payload: {
    updatable: UpdatableSkillInfo[];
    newSkills: NewSkillInfo[];
  },
  t: TFunction<'skills'>,
): boolean {
  if (payload.updatable.length === 0 && payload.newSkills.length === 0) {
    return false;
  }

  toast.custom(
    (toastId) => createElement(StartupSkillNotificationToast, {
      toastId,
      title: t('toast.updateReminder'),
      updatable: payload.updatable,
      newSkills: payload.newSkills,
      updatePrefix: t('toast.skillUpdatePrefix'),
      newPrefix: t('toast.skillNewPrefix'),
    }),
    {
      id: STARTUP_SKILL_NOTIFICATION_TOAST_ID,
      duration: 5000,
      unstyled: true,
    },
  );

  return true;
}
