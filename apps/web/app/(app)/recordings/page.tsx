'use client';

/**
 * Recordings — default view: EVERY recording (session) across all channels,
 * newest first. Filters (channel + date range + text search) narrow the
 * view. Each row is a logical recording spanning start-of-record to
 * stop-of-record, not the 60 s ffmpeg segment.
 *
 * Click Play → streams the session in the browser (assembled from the
 * segments it spans). Click Create clip → jumps to /clips/new with the
 * session preselected.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import Hls from 'hls.js';
import { Film, Play, Search, Scissors, Download, X } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { fmtBytes, fmtDurationMs } from '@/lib/utils';
import { DemoScopeBanner } from '@/components/demo-scope-banner';

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

interface Channel { id: string; name: string; slug: string }

export default function RecordingsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [channelId, setChannelId] = useState<string>('all');
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState<string>(today);
  const [q, setQ] = useState('');
  const [playing, setPlaying] = useState<Session | null>(null);

  const { data: channels } = useQuery<Channel[]>({
    queryKey: ['channels.for-recordings'],
    queryFn: () => api<Channel[]>('/api/channels'),
    staleTime: 60_000,
  });

  const { data: sessions, isLoading } = useQuery<Session[]>({
    queryKey: ['recordings.sessions', channelId, from, to],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('from', new Date(from + 'T00:00:00Z').toISOString());
      p.set('to',   new Date(to   + 'T23:59:59Z').toISOString());
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

  return (
    <div className="max-w-[1500px] mx-auto space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Recordings</h1>
          <p className="text-xs text-muted mt-0.5">
            30-day rolling archive. Grouped by recording session (start → stop). Filters narrow the view.
          </p>
        </div>
      </div>

      <DemoScopeBanner feature="Recording" />

      <Card className="p-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by channel name / slug" className="pl-9 h-9" />
          </div>
          <Select value={channelId} onValueChange={setChannelId}>
            <SelectTrigger className="w-52 h-9"><SelectValue placeholder="All channels" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {(channels ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2">
            <span className="text-muted-2 uppercase tracking-widest text-[10px]">From</span>
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="h-9 px-2 rounded-md border border-line bg-white font-mono" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-2 uppercase tracking-widest text-[10px]">To</span>
            <input type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)}
              className="h-9 px-2 rounded-md border border-line bg-white font-mono" />
          </label>
          <div className="text-muted-2 ml-auto whitespace-nowrap">{filtered.length} recordings</div>
        </div>
      </Card>

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
                    <th className="text-left px-4 py-2">Duration</th>
                    <th className="text-left px-4 py-2">Size</th>
                    <th className="text-left px-4 py-2">Segments</th>
                    <th className="text-left px-4 py-2">File / ID</th>
                    <th className="px-4 py-2 w-56"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filtered.map((s) => {
                    const started = new Date(s.startedAt);
                    return (
                      <tr key={s.id} className="hover:bg-panel/40">
                        <td className="px-4 py-2.5 font-medium">{s.channel.name}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">
                          {started.toLocaleString(undefined, {
                            year: 'numeric', month: '2-digit', day: '2-digit',
                            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
                          })}
                        </td>
                        <td className="px-4 py-2.5 font-mono text-xs">{fmtDurationMs(s.durationMs)}</td>
                        <td className="px-4 py-2.5 font-mono text-xs">{fmtBytes(Number(s.sizeBytes))}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-2">{s.segmentCount}</td>
                        <td className="px-4 py-2.5 font-mono text-[10px] text-muted-2">
                          {s.channel.slug}_{started.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-1 justify-end">
                            <Button size="sm" variant="secondary" onClick={() => setPlaying(s)}>
                              <Play className="h-3.5 w-3.5" /> Play
                            </Button>
                            <Link href={`/clips/new?channelId=${s.channelId}&sessionStart=${encodeURIComponent(s.startedAt)}&sessionEnd=${encodeURIComponent(s.endedAt)}`}>
                              <Button size="sm" variant="secondary" title="Create clip from this session">
                                <Scissors className="h-3.5 w-3.5" />
                              </Button>
                            </Link>
                          </div>
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

      {playing && <SessionPlayerModal session={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}

/**
 * HLS-backed session player. The server exposes an .m3u8 that lists
 * every 60-s segment covering [startedAt, endedAt]; hls.js loads only
 * the segments it needs. First frame appears in ~1-2 s regardless of
 * whether the session is 5 minutes or 24 hours long, and any seek
 * jumps straight to the target segment (streams the surrounding ones
 * in the background as a normal HLS buffer would).
 */
function SessionPlayerModal({ session, onClose }: { session: Session; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
    const p = new URLSearchParams();
    p.set('channelId', session.channelId);
    p.set('from', session.startedAt);
    p.set('to',   session.endedAt);
    const src = `${API_BASE}/api/recordings/session.m3u8?${p}`;

    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls({
        xhrSetup: (xhr) => { if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`); },
        // Tight rolling buffer — server splits each 60-s segment into
        // 6-s slices, so we only need 2-3 chunks ahead. On seek,
        // hls.js downloads a single ~1.5 MB slice and starts decoding
        // within ~500 ms instead of waiting for a whole 60-s file.
        maxBufferLength: 12,
        maxMaxBufferLength: 24,
        backBufferLength: 12,
        // Cap in-memory buffer to keep long sessions from ballooning.
        maxBufferSize: 8 * 1024 * 1024,
        // Fire the first XHR the moment a source is attached.
        startFragPrefetch: true,
        lowLatencyMode: false,
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (data.fatal) setError(`${data.type}: ${data.details}`);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari — can't add Auth header. Fall back to session-media MP4.
      const mp4 = `${API_BASE}/api/recordings/session-media?${p}${token ? `&t=${encodeURIComponent(token)}` : ''}`;
      video.src = mp4;
    } else {
      setError('This browser does not support HLS or Media Source Extensions.');
    }
    return () => { hls?.destroy(); };
  }, [session.channelId, session.startedAt, session.endedAt]);

  async function download() {
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
      const p = new URLSearchParams();
      p.set('channelId', session.channelId);
      p.set('from', session.startedAt);
      p.set('to',   session.endedAt);
      const r = await fetch(`${API_BASE}/api/recordings/session-media?${p}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${session.channel.slug}_${new Date(session.startedAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')}.mp4`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success('Recording downloaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed');
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-5xl bg-panel rounded-xl shadow-lift overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2 border-b border-line">
          <div>
            <div className="text-sm font-medium">
              {session.channel.name} — {new Date(session.startedAt).toLocaleString(undefined, { hour12: false })}
            </div>
            <div className="text-[10px] text-muted-2 font-mono">
              {fmtDurationMs(session.durationMs)} · {fmtBytes(Number(session.sizeBytes))} · {session.segmentCount} segments
            </div>
          </div>
          <button onClick={onClose} className="text-muted hover:text-txt"><X className="h-5 w-5" /></button>
        </div>
        <div className="bg-black">
          {error ? (
            <div className="p-10 text-center text-sm text-accent-red">
              Playback error: {error}
            </div>
          ) : (
            <video ref={videoRef} controls autoPlay className="w-full h-auto max-h-[70vh]" />
          )}
        </div>
        <div className="flex items-center justify-between px-4 py-2 border-t border-line">
          <div className="text-[11px] text-muted-2">Streaming from segments — scrub anywhere, buffer catches up in the background.</div>
          <Button size="sm" variant="secondary" onClick={download}>
            <Download className="h-3.5 w-3.5" /> Download .mp4
          </Button>
        </div>
      </div>
    </div>
  );
}
