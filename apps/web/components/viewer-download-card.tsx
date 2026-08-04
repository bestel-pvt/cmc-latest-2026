'use client';

/**
 * Card / button that surfaces the DEMP Viewer .exe. The API's
 * /api/downloads/desktop-viewer/manifest endpoint reports whether the
 * build is available (it is once ops has run the packaging step); if
 * not, we hide the download UI instead of showing a broken link.
 */

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Download, Monitor, Info } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fmtBytes } from '@/lib/utils';

interface Manifest {
  available: boolean;
  platform?: string;
  filename?: string;
  sizeBytes?: number;
  builtAt?: string;
  url?: string;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export function ViewerDownloadCard() {
  const { data } = useQuery<Manifest>({
    queryKey: ['desktop-viewer.manifest'],
    // Public endpoint — no auth header needed.
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/downloads/desktop-viewer/manifest`);
      return r.json();
    },
    staleTime: 60_000,
  });

  if (!data?.available) return null;

  return (
    <Card className="border-brand/40 bg-gradient-to-br from-brand/5 via-white to-transparent">
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-brand" />
            DEMP Viewer — Video Wall
          </CardTitle>
          <p className="text-xs text-muted mt-1 max-w-md">
            Native Windows app that plays every channel's satellite UDP directly (no
            transcoding). Grid up to 10×8, full-screen, per-tile channel switch.
          </p>
        </div>
        <Badge variant="brand" className="uppercase">Windows</Badge>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-3 flex-wrap pt-0">
        <div className="text-[11px] text-muted-2 font-mono">
          {data.filename} · {fmtBytes(data.sizeBytes ?? 0)} · built {new Date(data.builtAt ?? Date.now()).toLocaleString()}
        </div>
        <div className="flex items-center gap-2">
          <Button asChild size="sm" variant="secondary">
            <Link href="/downloads">
              <Info className="h-3.5 w-3.5" /> Install guide
            </Link>
          </Button>
          <Button asChild size="sm" variant="gradient">
            <a href={`${API_BASE}${data.url}`} download>
              <Download className="h-3.5 w-3.5" /> Download .exe
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
