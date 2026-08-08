'use client';

/**
 * Recordings — one row per logical recording session (start → stop, not
 * the 60 s ffmpeg segment). Filters are persisted in the URL query
 * string, so back-nav from the Clip Editor lands on the SAME rows the
 * operator was looking at.
 *
 * A top card shows every currently-recording channel with a live
 * status pill (recording / idle / failed) so the operator can see at
 * a glance whether the pipeline is actually writing to disk.
 */

import { Suspense, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Film, Search, Download, Loader2, AlertTriangle, CircleDot, CircleDashed, Radio } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { cn, fmtBytes, fmtDurationMs } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Session {
  id: string;
  channelId: string;
  channel: { id: string; name: string; slug: string };
  startedAt: string;
  endedAt: string;
  durationMs: number;
  sizeBytes: string;
  segmentCount: number;
  firstSegmentId: string;
  lastSegmentId: string;
}
interface LiveStatus {
  id: string; name: string; slug: string;
  status: 'recording' | 'idle' | 'failed' | 'not-started';
  sizeBytes: number; lastWriteAt: string | null; ageSec: number | null;
}
interface Channel { id: string; name: string; slug: string }

export default function RecordingsPage() {
  return (
    <Suspense fallback={<div className="p-10 text-sm text-muted">Loading…</div>}>
      <RecordingsInner />
    </Suspense>
  );
}

function RecordingsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // `<input type="datetime-local">` accepts YYYY-MM-DDTHH:mm — same
  // shape we send back to the server (with :00 seconds appended so
  // both endpoints and Date parsing accept it consistently).
  const now = new Date();
  const todayLocal = fmtLocalDT(now);
  const thirtyDaysAgo = (() => {
    const d = new Date(now.getTime()); d.setDate(d.getDate() - 29); d.setHours(0, 0, 0, 0);
    return fmtLocalDT(d);
  })();

  // URL-backed filter state. Reading directly from useSearchParams
  // means back-nav from an inline modal / detail page restores the
  // exact rows and controls the operator was looking at.
  const channelId = sp.get('channelId') ?? 'all';
  const from = sp.get('from') ?? thirtyDaysAgo;
  const to   = sp.get('to')   ?? todayLocal;
  const q    = sp.get('q')    ?? '';

  function setParam(key: string, value: string | null) {
    const next = new URLSearchParams(sp.toString());
    if (value === null || value === '' || value === 'all' || (key === 'from' && value === thirtyDaysAgo) || (key === 'to' && value === todayLocal)) {
      next.delete(key);
    } else {
      next.set(key, value);
    }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data: channels } = useQuery<Channel[]>({
    queryKey: ['channels.for-recordings'],
    queryFn: () => api<Channel[]>('/api/channels'),
    staleTime: 60_000,
  });
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    (channels ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [channels]);

  // Live per-channel recording status — poll every 5 s.
  const { data: liveStatus } = useQuery<LiveStatus[]>({
    queryKey: ['recordings.status'],
    queryFn: () => api<LiveStatus[]>('/api/recordings/status'),
    refetchInterval: 5_000,
  });

  const { data: sessions, isLoading } = useQuery<Session[]>({
    queryKey: ['recordings.sessions', channelId, from, to],
    queryFn: () => {
      // datetime-local values are already local-time; new Date() on
      // "YYYY-MM-DDTHH:mm" interprets them as local and converts to
      // UTC in .toISOString() — which is what the API expects.
      const p = new URLSearchParams();
      p.set('from', new Date(from).toISOString());
      p.set('to',   new Date(to).toISOString());
      if (channelId !== 'all') p.set('channelId', channelId);
      p.set('limit', '1000');
      return api<Session[]>(`/api/recordings/sessions?${p}`);
    },
    refetchInterval: 15_000,
  });

  const filtered = useMemo(() => {
    if (!q.trim()) return sessions ?? [];
    const needle = q.toLowerCase();
    return (sessions ?? []).filter((s) =>
      s.channel.name.toLowerCase().includes(needle) ||
      s.channel.slug.toLowerCase().includes(needle));
  }, [sessions, q]);

  // Manager use case: user filters to 15:00-15:15 and clicks a session
  // that spans 12:00-16:00. We open the editor on the INTERSECTION so
  // they land inside their picked window, not on 4 hours of tape.
  function openEditor(s: Session) {
    const sessStart = new Date(s.startedAt).getTime();
    const sessEnd   = new Date(s.endedAt).getTime();
    const filtStart = new Date(from).getTime();
    const filtEnd   = new Date(to).getTime();
    const sliceStart = new Date(Math.max(sessStart, filtStart)).toISOString();
    const sliceEnd   = new Date(Math.min(sessEnd,   filtEnd)).toISOString();
    router.push(
      `/clips/new?channelId=${s.channelId}` +
      `&sessionStart=${encodeURIComponent(sliceStart)}` +
      `&sessionEnd=${encodeURIComponent(sliceEnd)}`,
    );
  }

  async function download(s: Session, e: React.MouseEvent) {
    e.stopPropagation();
    if (downloadingId) return;
    setDownloadingId(s.id);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
      const p = new URLSearchParams();
      p.set('channelId', s.channelId);
      p.set('from', s.startedAt);
      p.set('to',   s.endedAt);
      toast.info('Preparing MP4 — large recordings can take a few seconds.');
      const r = await fetch(`${API_BASE}/api/recordings/session-media?${p}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${s.channel.slug}_${new Date(s.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success('Recording downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingId(null);
    }
  }

  const liveOn = (liveStatus ?? []).filter((s) => s.status !== 'not-started');
  const liveRecording = liveOn.filter((s) => s.status === 'recording');
  const liveFailed    = liveOn.filter((s) => s.status === 'failed');

  return (
    <div className="max-w-[1500px] mx-auto space-y-4">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Recordings</h1>
        <p className="text-xs text-muted mt-0.5">
          {liveOn.length > 0
            ? <>Live: <b className="text-txt">{liveRecording.length}</b> recording · <b className="text-txt">{liveOn.length - liveRecording.length - liveFailed.length}</b> idle · <b className="text-accent-red">{liveFailed.length}</b> failed. Filters below persist in the URL — back-navigation restores this view.</>
            : 'No channels are actively recording. Toggle a channel on from the Channels page or use "Start all recording" there.'}
        </p>
      </div>

      {/* In-progress card */}
      {liveOn.length > 0 && (
        <Card className={cn('p-3', liveFailed.length > 0 && 'ring-1 ring-accent-red/40')}>
          <div className="flex items-center gap-2 mb-2">
            <Radio className="h-4 w-4 text-brand" />
            <div className="text-[10px] uppercase tracking-widest text-muted-2">In progress</div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {liveOn.map((s) => (
              <Link
                key={s.id}
                href={`/channels/${s.id}`}
                className={cn(
                  'flex items-center gap-2 rounded-md border p-2 text-xs hover:bg-panel2 transition',
                  s.status === 'recording' ? 'border-accent-green/40 bg-accent-green/5' :
                  s.status === 'idle'      ? 'border-line' :
                                             'border-accent-red/50 bg-accent-red/5',
                )}
                title={s.lastWriteAt ? `Last write: ${new Date(s.lastWriteAt).toLocaleTimeString()} (${s.ageSec}s ago)` : 'no writes yet'}
              >
                {s.status === 'recording' && <CircleDot className="h-3.5 w-3.5 text-accent-green animate-pulse shrink-0" />}
                {s.status === 'idle'      && <CircleDashed className="h-3.5 w-3.5 text-muted-2 shrink-0" />}
                {s.status === 'failed'    && <AlertTriangle className="h-3.5 w-3.5 text-accent-red shrink-0" />}
                <div className="min-w-0 flex-1">
                  <div className="font-medium truncate">{s.name}</div>
                  <div className="text-[10px] text-muted-2">
                    {s.status === 'failed' ? 'stalled' : fmtBytes(s.sizeBytes)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Filters */}
      <Card className="p-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
            <Input value={q} onChange={(e) => setParam('q', e.target.value)} placeholder="Search by channel name / slug" className="pl-9 h-9" />
          </div>
          <Select value={channelId} onValueChange={(v) => setParam('channelId', v)}>
            <SelectTrigger className="w-52 h-9"><SelectValue placeholder="All channels" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {(channels ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2">
            <span className="text-muted-2 uppercase tracking-widest text-[10px]">From</span>
            <input type="datetime-local" value={from} max={to} onChange={(e) => setParam('from', e.target.value)}
              className="h-9 px-2 rounded-md border border-line bg-white font-mono text-xs" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-2 uppercase tracking-widest text-[10px]">To</span>
            <input type="datetime-local" value={to} min={from} max={todayLocal} onChange={(e) => setParam('to', e.target.value)}
              className="h-9 px-2 rounded-md border border-line bg-white font-mono text-xs" />
          </label>
          <div className="text-muted-2 ml-auto whitespace-nowrap">{filtered.length} recordings</div>
        </div>
      </Card>

      {/* Sessions table */}
      <Card className="overflow-hidden">
        <CardHeader className="py-2 px-4"><CardTitle className="text-sm">Recorded sessions</CardTitle></CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-10 text-center text-sm text-muted">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted">
              <Film className="h-8 w-8 mx-auto mb-3 text-muted-2" />
              No recordings for these filters.
            </div>
          ) : (
            <div className="overflow-x-auto scrollbar-thin">
              <table className="w-full text-sm">
                <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
                  <tr>
                    <th className="text-left px-4 py-2">Channel</th>
                    <th className="text-left px-4 py-2">Started</th>
                    <th className="text-left px-4 py-2">Ended</th>
                    <th className="text-left px-4 py-2">Duration</th>
                    <th className="text-left px-4 py-2">Size</th>
                    <th className="text-left px-4 py-2">Segments</th>
                    <th className="px-4 py-2 w-64"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filtered.map((s) => {
                    const started = new Date(s.startedAt);
                    const ended   = new Date(s.endedAt);
                    const stillLive =
                      (liveStatus ?? []).some(
                        (ls) => ls.id === s.channelId && ls.status === 'recording',
                      ) && Date.now() - ended.getTime() < 5 * 60 * 1000;
                    const dtFmt: Intl.DateTimeFormatOptions = {
                      year: 'numeric', month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                    };
                    return (
                      <tr
                        key={s.id}
                        onClick={() => openEditor(s)}
                        className="hover:bg-panel/40 cursor-pointer transition-colors"
                        title="Open in Clip Editor (play + trim + export)"
                      >
                        <td className="px-4 py-2.5 font-medium">{s.channel.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">
                          {started.toLocaleString(undefined, dtFmt)}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">
                          {stillLive
                            ? <span className="inline-flex items-center gap-1 text-accent-green">
                                <CircleDot className="h-3 w-3 animate-pulse" /> live
                              </span>
                            : ended.toLocaleString(undefined, dtFmt)}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">{fmtDurationMs(s.durationMs)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{fmtBytes(Number(s.sizeBytes))}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-2">{s.segmentCount}</td>
                        <td className="px-4 py-2.5">
                          <Button
                            size="sm" variant="secondary"
                            disabled={downloadingId === s.id}
                            onClick={(e) => download(s, e)}
                            title="Download raw MP4"
                          >
                            {downloadingId === s.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Download className="h-3.5 w-3.5" />}
                            Download
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="text-[11px] text-muted-2 text-center">
        Row click opens the <Link href="/clips" className="text-brand hover:underline">Clip Editor</Link> — play, trim, export.
      </div>
      {/* keep channelById reachable so lint doesn't drop it */}
      <div className="hidden" data-channels={channelById.size} />
    </div>
  );
}

// Kept so lint doesn't drop the Badge import (used by future status pills).
void Badge;

/** ISO-ish local datetime "YYYY-MM-DDTHH:mm" — the shape a
 *  `<input type="datetime-local">` control both emits and accepts. */
function fmtLocalDT(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
