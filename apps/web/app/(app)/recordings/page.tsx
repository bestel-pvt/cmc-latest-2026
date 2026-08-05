'use client';

/**
 * Recordings — one row per logical recording session (start → stop, not the
 * 60 s ffmpeg segment). Click a row to open the Clip Editor with the full
 * session loaded; download the raw MP4 from the inline action. No separate
 * preview player — the editor IS the player.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Film, Search, Download, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { fmtBytes, fmtDurationMs } from '@/lib/utils';

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
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [channelId, setChannelId] = useState<string>('all');
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 29);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState<string>(today);
  const [q, setQ] = useState('');
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

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

  function openEditor(s: Session) {
    router.push(
      `/clips/new?channelId=${s.channelId}` +
      `&sessionStart=${encodeURIComponent(s.startedAt)}` +
      `&sessionEnd=${encodeURIComponent(s.endedAt)}`,
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

  return (
    <div className="max-w-[1500px] mx-auto space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Recordings</h1>
          <p className="text-xs text-muted mt-0.5">
            30-day rolling archive. Click any row to open it in the Clip Editor — trim, watermark, export.
          </p>
        </div>
      </div>

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
                    <th className="px-4 py-2 w-32"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {filtered.map((s) => {
                    const started = new Date(s.startedAt);
                    return (
                      <tr
                        key={s.id}
                        onClick={() => openEditor(s)}
                        className="hover:bg-panel/40 cursor-pointer transition-colors"
                        title="Open in Clip Editor"
                      >
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
                          <Button
                            size="sm"
                            variant="secondary"
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
        Tip: click a row to open it in the <Link href="/clips" className="text-brand hover:underline">Clip Editor</Link>.
      </div>
    </div>
  );
}
