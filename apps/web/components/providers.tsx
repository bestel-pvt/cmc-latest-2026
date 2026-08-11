'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'sonner';
import { useEffect, useState } from 'react';

export function Providers({ children }: { children: React.ReactNode }) {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, refetchOnWindowFocus: false, retry: 1 },
    },
  }));

  // After a server redeploy the browser's cached HTML shell references
  // chunk hashes that no longer exist -> ChunkLoadError -> blank page.
  // Force a hard reload so the fresh HTML + fresh chunk names land
  // together. Time-based cooldown (5 min) instead of once-per-session
  // — if the operator hits a chunk error again 30 min later (another
  // redeploy happened), they get another auto-reload instead of a
  // permanently-broken tab.
  useEffect(() => {
    const RELOAD_TS_KEY = 'cmc-chunk-reload-at';
    const COOLDOWN_MS = 5 * 60 * 1000;
    const shouldReload = (msg: unknown): boolean => {
      const s = typeof msg === 'string' ? msg : (msg as Error)?.message ?? '';
      const name = (msg as Error)?.name ?? '';
      return name === 'ChunkLoadError' || /Loading chunk .* failed/i.test(s);
    };
    const trigger = () => {
      const last = Number(sessionStorage.getItem(RELOAD_TS_KEY) ?? '0');
      if (Date.now() - last < COOLDOWN_MS) return;   // just reloaded, don't loop
      sessionStorage.setItem(RELOAD_TS_KEY, String(Date.now()));
      window.location.reload();
    };
    const onError = (e: ErrorEvent) => { if (shouldReload(e.error ?? e.message)) trigger(); };
    const onRejection = (e: PromiseRejectionEvent) => { if (shouldReload(e.reason)) trigger(); };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  return (
    <QueryClientProvider client={qc}>
      {children}
      <Toaster theme="light" position="top-right" richColors closeButton />
    </QueryClientProvider>
  );
}
