'use client';

import { useEffect } from 'react';

// Catches errors thrown during render of the root layout (e.g. a
// missing layout chunk after a redeploy — Providers.tsx's window
// listener runs too late for that case because Providers is inside
// the layout that failed to load).
//
// A ChunkLoadError here means the browser's HTML shell references a
// build that no longer exists on the server. One hard reload fixes
// it. Guard via sessionStorage so a genuinely broken build cannot
// trigger a reload loop.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    const RELOAD_FLAG = 'cmc-chunk-reload-fired';
    const s = error?.message ?? String(error);
    const isChunk = error?.name === 'ChunkLoadError' || /Loading chunk .* failed/i.test(s);
    if (isChunk && !sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, String(Date.now()));
      window.location.reload();
    }
  }, [error]);

  return (
    <html>
      <body style={{ margin: 0, background: '#0A1124', color: '#e8ecf5',
                     fontFamily: 'system-ui, sans-serif',
                     display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <div style={{ fontSize: 18, opacity: 0.8, marginBottom: 8 }}>Reloading…</div>
          <div style={{ fontSize: 13, opacity: 0.5 }}>If this doesn't clear in a moment, hard-refresh (Ctrl+Shift+R).</div>
        </div>
      </body>
    </html>
  );
}
