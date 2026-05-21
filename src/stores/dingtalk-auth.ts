import { create } from 'zustand';
import {
  getDingTalkUser,
  loginWithDingTalk,
  logoutDingTalk,
  type DingTalkUserInfo,
} from '@/lib/host-api';

interface DingTalkAuthState {
  user: DingTalkUserInfo | null;
  /** True after a completed DingTalk OAuth login; consumed when workspace welcome is sent. */
  dingTalkWelcomeAfterWorkspacePending: boolean;
  initialized: boolean;
  loading: boolean;
  error: string | null;
  init: () => Promise<void>;
  /** @param fromFreshDingTalkOAuth pass true only when user was just obtained from OAuth (not init restore). */
  setUser: (user: DingTalkUserInfo | null, fromFreshDingTalkOAuth?: boolean) => void;
  login: (force?: boolean) => Promise<DingTalkUserInfo | null>;
  logout: () => Promise<void>;
  /** Returns whether a post-workspace BFF welcome should run once, then clears the flag. */
  consumeDingTalkLoginWelcomePending: () => boolean;
}

export const useDingTalkAuthStore = create<DingTalkAuthState>((set, get) => ({
  user: null,
  dingTalkWelcomeAfterWorkspacePending: false,
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
        dingTalkWelcomeAfterWorkspacePending: false,
        initialized: true,
        loading: false,
      });
    } catch (error) {
      set({
        user: null,
        dingTalkWelcomeAfterWorkspacePending: false,
        initialized: true,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  setUser: (user, fromFreshDingTalkOAuth = false) =>
    set({
      user,
      initialized: true,
      error: null,
      dingTalkWelcomeAfterWorkspacePending: Boolean(user) && fromFreshDingTalkOAuth,
    }),

  login: async (force = false) => {
    set({ loading: true, error: null });
    try {
      const result = await loginWithDingTalk(force);
      const user = result.success ? result.user : null;
      const dingTalkWelcomeAfterWorkspacePending =
        Boolean(user) && result.alreadyLoggedIn !== true;
      set({ user, initialized: true, loading: false, dingTalkWelcomeAfterWorkspacePending });
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
      set({ user: null, dingTalkWelcomeAfterWorkspacePending: false, initialized: true, loading: false });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  },

  consumeDingTalkLoginWelcomePending: () => {
    if (!get().dingTalkWelcomeAfterWorkspacePending) return false;
    set({ dingTalkWelcomeAfterWorkspacePending: false });
    return true;
  },
}));
