import { create } from 'zustand';
import {
  getDingTalkUser,
  loginWithDingTalk,
  logoutDingTalk,
  type DingTalkUserInfo,
} from '@/lib/host-api';

interface DingTalkAuthState {
  user: DingTalkUserInfo | null;
  initialized: boolean;
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  setUser: (user: DingTalkUserInfo | null) => void;
  login: (force?: boolean) => Promise<DingTalkUserInfo | null>;
  logout: () => Promise<void>;
}

export const useDingTalkAuthStore = create<DingTalkAuthState>((set, get) => ({
  user: null,
  initialized: false,
  loading: false,
  error: null,

  init: async () => {
    if (get().initialized || get().loading) return;
    set({ loading: true, error: null });
    try {
      const result = await getDingTalkUser();
      set({
        user: result.success ? result.user : null,
        initialized: true,
        loading: false,
      });
    } catch (error) {
      set({
        user: null,
        initialized: true,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setUser: (user) => set({ user, initialized: true, error: null }),

  login: async (force = false) => {
    set({ loading: true, error: null });
    try {
      const result = await loginWithDingTalk(force);
      const user = result.success ? result.user : null;
      set({ user, initialized: true, loading: false });
      return user;
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    try {
      await logoutDingTalk();
      set({ user: null, initialized: true, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },
}));
