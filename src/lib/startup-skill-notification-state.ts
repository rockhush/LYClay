import { create } from 'zustand';
import {
  detectNewUninstalledSkills,
  detectUpdatableInstalledSkills,
  type NewSkillInfo,
  type UpdatableSkillInfo,
} from '@/lib/skill-update-check';

interface StartupSkillNotificationState {
  updatable: UpdatableSkillInfo[];
  newSkills: NewSkillInfo[];
  ready: boolean;
  refreshing: boolean;
  setPending: (updatable: UpdatableSkillInfo[], newSkills: NewSkillInfo[]) => void;
  refresh: () => Promise<void>;
}

export const useStartupSkillNotificationStore = create<StartupSkillNotificationState>((set) => ({
  updatable: [],
  newSkills: [],
  ready: false,
  refreshing: false,
  setPending: (updatable, newSkills) => {
    set({ updatable, newSkills, ready: true });
  },
  refresh: async () => {
    set({ refreshing: true });
    try {
      const updatable = await detectUpdatableInstalledSkills();
      const newSkills = detectNewUninstalledSkills();
      set({ updatable, newSkills, ready: true });
    } catch (error) {
      console.warn('[StartupSkillNotification] refresh failed (silent):', error);
    } finally {
      set({ refreshing: false });
    }
  },
}));

export function hasPendingStartupSkillNotifications(input: {
  ready: boolean;
  updatable: UpdatableSkillInfo[];
  newSkills: NewSkillInfo[];
}): boolean {
  return input.ready && (input.updatable.length > 0 || input.newSkills.length > 0);
}

export async function refreshStartupSkillNotificationState(): Promise<void> {
  await useStartupSkillNotificationStore.getState().refresh();
}
