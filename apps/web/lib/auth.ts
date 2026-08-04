'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from './api';

export type Role = 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';
export interface AuthUser { id: string; email: string; name: string; role: Role }

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  setUser: (u: AuthUser | null) => void;
}

export const useAuth = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      accessToken: null,
      refreshToken: null,
      login: async (email, password) => {
        const res = await api<{ accessToken: string; refreshToken: string; user: AuthUser }>(
          '/api/auth/login',
          { method: 'POST', body: { email, password } },
        );
        if (typeof window !== 'undefined') localStorage.setItem('demp.accessToken', res.accessToken);
        set({ user: res.user, accessToken: res.accessToken, refreshToken: res.refreshToken });
      },
      logout: () => {
        if (typeof window !== 'undefined') localStorage.removeItem('demp.accessToken');
        set({ user: null, accessToken: null, refreshToken: null });
        void api('/api/auth/logout', { method: 'POST' }).catch(() => {});
      },
      setUser: (user) => set({ user }),
    }),
    {
      name: 'demp.auth',
      onRehydrateStorage: () => (state) => {
        // Keep the raw access-token duplicated in localStorage under a stable key
        // so the api() helper can read it synchronously without going through the store.
        if (typeof window !== 'undefined' && state?.accessToken) {
          localStorage.setItem('demp.accessToken', state.accessToken);
        }
      },
    },
  ),
);

/**
 * Returns `true` only after zustand's persist middleware has rehydrated from
 * localStorage on the client. Use this to gate any auth-conditional redirect
 * — otherwise the first client render sees a stale `user: null` and boots the
 * user back to /login on every refresh.
 */
export function useAuthHydrated(): boolean {
  // Server render + first client render both start `false` — this keeps SSR
  // and hydration matching. useEffect flips it once persist has finished.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (useAuth.persist.hasHydrated()) { setHydrated(true); return; }
    const unsubFinish = useAuth.persist.onFinishHydration(() => setHydrated(true));
    return () => { unsubFinish(); };
  }, []);
  return hydrated;
}
