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
  // Force a single hard reload so the fresh HTML + fresh chunk names
  // land together. Guarded to fire at most once per session to avoid a
  // reload loop if the fresh build is genuinely broken.
  useEffect(() => {
    const RELOAD_FLAG = 'cmc-chunk-reload-fired';
    const shouldReload = (msg: unknown): boolean => {
      const s = typeof msg === 'string' ? msg : (msg as Error)?.message ?? '';
      const name = (msg as Error)?.name ?? '';
      return name === 'ChunkLoadError' || /Loading chunk .* failed/i.test(s);
    };
    const trigger = () => {
      if (sessionStorage.getItem(RELOAD_FLAG)) return;
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
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
