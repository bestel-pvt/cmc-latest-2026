'use client';

/**
 * Four supplemental panels shown on the channel detail page:
 *   - RecordingStatusPanel   — is recording running? counts today, latest segment
 *   - SwitchHistoryPanel     — recent SOURCE_SWITCH alerts (from → to)
 *   - TickerThumbGrid        — last N ticker events with OCR image + text
 *   - LogoUploader           — inline PNG/WEBP/JPG upload for Channel.logoUrl
 *
 * Everything reads from existing endpoints; no new API needed apart from
 * /api/channels/:id/logo which the API route file already exposes.
 */

import { useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { Film, RefreshCw, ScanText, Upload, ImagePlus, ArrowRight, Newspaper, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { AuthImg } from '@/components/auth-img';
import { cn, fmtBytes, fmtDurationMs } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// ---------------- Logo uploader ----------------

export function LogoUploader({ channelId, currentUrl }: { channelId: string; currentUrl: string | null }) {
  const qc = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('logo', file, file.name);
      const token = localStorage.getItem('demp.accessToken');
      const res = await fetch(`/api/channels/${channelId}/logo`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: fd,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      qc.invalidateQueries({ queryKey: ['channel', channelId] });
      toast.success('Logo uploaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally { setBusy(false); }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="h-16 w-16 rounded-md border border-line bg-white overflow-hidden flex items-center justify-center">
        {currentUrl
          ? <AuthImg src={currentUrl} alt="channel logo" className="max-w-full max-h-full object-contain"
                     fallback={<ImagePlus className="h-6 w-6 text-muted-2" />} />
          : <ImagePlus className="h-6 w-6 text-muted-2" />}
      </div>
      <div>
        <input
          ref={inputRef}
          type="file"
          accept=".png,.webp,.jpg,.jpeg,image/png,image/webp,image/jpeg"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); }}
        />
        <Button variant="secondary" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
          <Upload className="h-3.5 w-3.5" /> {currentUrl ? 'Replace logo' : 'Upload logo'}
        </Button>
        <div className="text-[10px] text-muted-2 mt-1">PNG · WEBP · JPEG · JPG</div>
      </div>
    </div>
  );
}

// ---------------- Recording status ----------------

interface Segment { id: string; startedAt: string; durationMs: number; sizeBytes: string | number; sha256: string }

interface RecSession {
  id: string; startedAt: string; endedAt: string;
  durationMs: number; sizeBytes: string; segmentCount: number;
}

export function RecordingStatusPanel({ channelId, aiEnabled }: { channelId: string; aiEnabled: boolean }) {
  const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: sessions } = useQuery<RecSession[]>({
    queryKey: ['channel.sessions-24h', channelId],
    queryFn: () => api<RecSession[]>(`/api/recordings/sessions?channelId=${channelId}&from=${from}&limit=200`),
    refetchInterval: 15_000,
  });
  const latest = sessions?.[0];   // sessions come newest-first
  const running = latest ? Date.now() - new Date(latest.endedAt).getTime() < 3 * 60 * 1000 : false;
  const totalBytes = (sessions ?? []).reduce((s, x) => s + Number(x.sizeBytes), 0);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Film className="h-4 w-4 text-brand" /> Recording status</CardTitle>
        {aiEnabled
          ? (running ? <Badge variant="green" className="gap-1"><span className="h-1.5 w-1.5 rounded-full bg-white animate-pulse" /> LIVE</Badge>
                     : <Badge variant="amber">IDLE</Badge>)
          : <Badge variant="outline">DISABLED (demo scope)</Badge>}
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-2">Recordings 24h</div>
            <div className="font-display text-2xl font-bold mt-1">{sessions?.length ?? 0}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-2">Written 24h</div>
            <div className="font-display text-2xl font-bold mt-1">{fmtBytes(totalBytes)}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-muted-2">Latest</div>
            <div className="font-mono text-xs mt-1 text-muted">{latest ? new Date(latest.startedAt).toLocaleTimeString() : '—'}</div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-end">
          <Link href={`/recordings`} className="text-xs text-brand inline-flex items-center gap-1 hover:underline">
            Browse recordings <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------- Switch history ----------------

interface SwitchAlert { id: string; matchedText: string | null; createdAt: string; payload: { fromSourceId?: string; toSourceId?: string } | null }

export function SwitchHistoryPanel({ channelId, sources }: { channelId: string; sources: Array<{ id: string; url: string; kind: string }> }) {
  const { data: alerts } = useQuery<SwitchAlert[]>({
    queryKey: ['channel.switches', channelId],
    queryFn: () => api<SwitchAlert[]>(`/api/alerts?channelId=${channelId}&kind=SOURCE_SWITCH&limit=20`),
    refetchInterval: 15_000,
  });
  const srcMap = useMemo(() => new Map(sources.map((s) => [s.id, s])), [sources]);

  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2"><RefreshCw className="h-4 w-4 text-brand" /> Recent source switches</CardTitle></CardHeader>
      <CardContent className="p-0">
        <ul className="divide-y divide-line max-h-[280px] overflow-y-auto scrollbar-thin">
          {(alerts ?? []).map((a) => {
            const from = a.payload?.fromSourceId ? srcMap.get(a.payload.fromSourceId) : null;
            const to   = a.payload?.toSourceId   ? srcMap.get(a.payload.toSourceId)   : null;
            return (
              <li key={a.id} className="px-4 py-2.5 text-xs">
                <div className="flex items-center gap-2 text-muted-2 font-mono text-[10px]">
                  {new Date(a.createdAt).toISOString().replace('T', ' ').slice(0, 19)}
                  <Badge variant="outline" className="normal-case">{a.matchedText ?? 'switch'}</Badge>
                </div>
                <div className="mt-1 flex items-center gap-1.5 truncate">
                  <span className="text-muted-2 font-mono truncate max-w-[200px]">{from?.url ?? '—'}</span>
                  <ArrowRight className="h-3 w-3 text-brand shrink-0" />
                  <span className="text-txt font-mono truncate max-w-[200px]">{to?.url ?? '—'}</span>
                </div>
              </li>
            );
          })}
          {(alerts?.length ?? 0) === 0 && <li className="p-6 text-center text-xs text-muted-2">No switches recorded yet.</li>}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------- Ticker thumbnail grid ----------------

interface TickerEvent {
  id: string; kind: 'TICKER' | 'FLASHER_LEFT' | 'FLASHER_RIGHT';
  text: string; language: string; durationMs: number;
  startedAt: string; confidence: number;
}

export function TickerThumbGrid({ channelId, aiEnabled }: { channelId: string; aiEnabled: boolean }) {
  const { data: events } = useQuery<TickerEvent[]>({
    queryKey: ['channel.tickers-12', channelId],
    queryFn: () => api<TickerEvent[]>(`/api/tickers/events?channelId=${channelId}&limit=12`),
    refetchInterval: 15_000,
  });

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><ScanText className="h-4 w-4 text-brand" /> Recent ticker &amp; flasher events</CardTitle>
        {!aiEnabled && <Badge variant="outline">DISABLED (demo scope)</Badge>}
      </CardHeader>
      <CardContent>
        {(events?.length ?? 0) === 0 ? (
          <div className="text-xs text-muted-2 text-center py-6">No events yet on this channel.</div>
        ) : (
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {events!.map((e) => {
              const Icon = e.kind === 'TICKER' ? Newspaper : Zap;
              return (
                <li key={e.id} className="rounded-md border border-line bg-white overflow-hidden hover:border-brand/40 transition-colors">
                  <div className="relative h-16 bg-black">
                    <AuthImg src={`/api/tickers/events/${e.id}/image`} alt="ticker strip" className="absolute inset-0 w-full h-full object-cover" />
                    <div className="absolute top-1 left-1 flex items-center gap-1">
                      <Badge variant={e.kind === 'TICKER' ? 'brand' : 'cyan'} className="gap-1"><Icon className="h-2.5 w-2.5" /> {e.kind === 'TICKER' ? 'TICKER' : e.kind === 'FLASHER_LEFT' ? 'FL LEFT' : 'FL RIGHT'}</Badge>
                    </div>
                  </div>
                  <div className="p-2.5">
                    <div className="text-xs line-clamp-2 leading-snug">{e.text}</div>
                    <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-2 font-mono">
                      <span>{new Date(e.startedAt).toLocaleTimeString()}</span>
                      <span>{fmtDurationMs(e.durationMs)} · {(e.confidence * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
