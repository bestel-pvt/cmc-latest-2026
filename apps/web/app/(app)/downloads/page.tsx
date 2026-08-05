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
          CMC Video Wall — the desktop client that drives the operations-room wall.
          Joins the satellite UDP multicast for every channel directly and composes
          them into a Single, Dual, Mosaic-20, or Grid-32 layout.
        </p>
      </div>

      {/* Windows card */}
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="h-4 w-4 text-brand" />
              CMC Video Wall for Windows
            </CardTitle>
            <p className="text-xs text-muted mt-1 max-w-lg">
              Native Rust + GStreamer build. Portable ZIP — extract anywhere and
              double-click. No installer, no admin rights, no external dependencies.
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
            <div className="text-[10px] uppercase tracking-widest text-muted-2 mb-2">Install &amp; run</div>
            <div className="space-y-2 text-sm">
              <Step n={1}>Click <b>Download</b> above.</Step>
              <Step n={2}>Right-click the ZIP → <b>Properties → Unblock</b> (Windows "downloaded from internet" flag).</Step>
              <Step n={3}>Extract the ZIP anywhere on a local drive — <span className="font-mono">C:\CMC-VideoWall\</span> is the convention.</Step>
              <Step n={4}>Double-click <span className="font-mono">CMC-VideoWall.cmd</span>. First launch shows the sign-in dialog.</Step>
              <Step n={5}>Sign in with your CMC credentials and the API address <span className="font-mono">http://10.51.80.202:4001</span>. Fill in <b>Multicast NIC IP</b> if the PC has more than one network card.</Step>
              <Step n={6}>Pick a layout from the toolbar (Single / Dual / Mosaic-20 / Grid-32) then click <b>Start Fullscreen</b>.</Step>
              <Step n={7}>
                Keys inside fullscreen: <kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] bg-panel2/70">F11</kbd> toggle,
                {' '}<kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] bg-panel2/70">Esc</kbd> exit,
                {' '}<kbd className="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] bg-panel2/70">Right-click</kbd> tile for Fill mode / Clear slot.
              </Step>
            </div>
            <p className="text-[11px] text-muted-2 mt-3">
              Preferences (which channel goes in which slot, fill modes) live in <span className="font-mono">%APPDATA%\CMC-VideoWall\</span> so upgrading is safe — just extract the new ZIP over the old folder.
            </p>
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
