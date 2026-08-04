'use client';

/**
 * <AuthImg> — <img> that fetches its bytes with the DEMP bearer token,
 * then hands the resulting blob URL to a native <img>. Needed anywhere
 * the API image endpoint is behind `authenticate`, because a plain
 * <img src> can't attach an Authorization header.
 */

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  src: string;              // absolute or /api-prefixed path
  fallback?: React.ReactNode;
}

export function AuthImg({ src, className, fallback, ...rest }: Props) {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let revoke: string | null = null;
    let cancelled = false;

    (async () => {
      setStatus('loading');
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
        const url = src.startsWith('http') ? src : `${API_BASE}${src}`;
        const r = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = await r.blob();
        if (cancelled) return;
        const u = URL.createObjectURL(b);
        revoke = u;
        setBlobUrl(u);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [src]);

  if (status === 'error') return <>{fallback ?? null}</>;
  if (!blobUrl) {
    return <div className={cn('bg-panel2/60 animate-pulse', className)} aria-hidden />;
  }
  // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
  return <img src={blobUrl} className={className} {...rest} />;
}
