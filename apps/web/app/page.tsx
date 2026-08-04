'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth, useAuthHydrated } from '@/lib/auth';

export default function RootPage() {
  const router = useRouter();
  const hydrated = useAuthHydrated();
  const user = useAuth((s) => s.user);
  useEffect(() => {
    if (!hydrated) return;
    router.replace(user ? '/dashboard' : '/login');
  }, [router, hydrated, user]);
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="h-6 w-6 animate-spin text-brand" />
    </div>
  );
}
