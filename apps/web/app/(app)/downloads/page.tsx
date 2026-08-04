'use client';

/**
 * Downloads — one card per platform. Each has its own install guide
 * beneath the download button. Button just says "Download".
 */

import { useQuery } from '@tanstack/react-query';
import { Download, Monitor } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { fmtBytes } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface BuildInfo {
  platform: 'windows' | 'linux';
  filename: string;
  sizeBytes: number;
  builtAt: string;
  notes?: string;
  url: string;
}
interface Manifest {
  available: boolean;
  builds?: BuildInfo[];
}

export default function DownloadsPage() {
  const { data } = useQuery<Manifest>({
    queryKey: ['desktop-viewer.manifest'],
    queryFn: async () => {
      const r = await fetch(`${API_BASE}/api/downloads/desktop-viewer/manifest`);
      return r.json();
    },
  });

  const win  = data?.builds?.find((b) => b.platform === 'windows');

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight flex items-center gap-2">
          <Download className="h-5 w-5 text-brand" />
          Downloads
        </h1>
        <p className="text-xs text-muted mt-1">
          CMC Viewer — the desktop video wall. Plays every channel's satellite feed
          directly at source quality, no browser codec limits.
        </p>
      </div>

      {/* Windows card */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-brand" />
              CMC Viewer for Windows
            </CardTitle>
            <p className="text-xs text-muted mt-1 max-w-lg">
              Self-contained. Bundles VLC + all Python dependencies — just
              double-click to run.
            </p>
          </div>
          <Badge variant="brand" className="uppercase">Windows 64-bit</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {win ? (
            <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-line">
              <div className="text-[11px] text-muted-2 font-mono">
                {win.filename} · {fmtBytes(win.sizeBytes)} · built {new Date(win.builtAt).toLocaleString()}
              </div>
              <Button asChild size="sm" variant="gradient">
                <a href={`${API_BASE}${win.url}`} download>
                  <Download className="h-3.5 w-3.5" /> Download
                </a>
              </Button>
            </div>
          ) : (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              Windows build not published yet.
            </div>
          )}

          <div className="pt-2 border-t border-line">
            <div className="text-[10px] uppercase tracking-widest text-muted-2 mb-2">Install</div>
            <div className="space-y-2 text-sm">
              <Step n={1}>Click <b>Download</b> above.</Step>
              <Step n={2}>Double-click the <span className="font-mono">CMC-Viewer.exe</span> file.</Step>
              <Step n={3}>Windows may warn "unrecognised app" — click <b>More info → Run anyway</b> (it's unsigned; that's expected).</Step>
              <Step n={4}>Sign in with the same email + password you use on this web app.</Step>
              <Step n={5}>Pick a grid size from the toolbar. Right-click any tile to change its channel.</Step>
              <Step n={6}>
                Keys: <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] bg-panel2/70">F11</kbd> fullscreen,
                {' '}<kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] bg-panel2/70">Esc</kbd> exit,
                {' '}<kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] bg-panel2/70">Double-click</kbd> solo a tile.
              </Step>
            </div>
          </div>
        </CardContent>
      </Card>

    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="shrink-0 h-6 w-6 rounded-full bg-brand/10 text-brand text-xs font-bold flex items-center justify-center">{n}</div>
      <div className="flex-1">{children}</div>
    </div>
  );
}
