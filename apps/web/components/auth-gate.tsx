'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth, useAuthHydrated } from '@/lib/auth';

/**
 * Blocks children until the persisted auth state has been rehydrated from
 * localStorage. Without this gate, a full-page refresh flashes `user=null`
 * for one render and bounces the operator back to /login.
 */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const hydrated = useAuthHydrated();
  const user = useAuth((s) => s.user);

  useEffect(() => {
    if (!hydrated) return;
    if (!user) router.replace('/login');
  }, [hydrated, user, router]);

  if (!hydrated) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand" />
      </div>
    );
  }
  if (!user) return null;
  return <>{children}</>;
}
