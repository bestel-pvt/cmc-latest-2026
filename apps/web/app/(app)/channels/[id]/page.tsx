'use client';

/**
 * Channel detail — CMC edition.
 *
 * Everything on this page is either operator input or read-only state
 * that lives elsewhere on the server. Sources are a single row (no
 * failover), no ticker/flasher regions, no AI toggles, no health
 * scoring — CMC has none of that. What's left:
 *   1. Live HLS preview + camera snapshot button
 *   2. Basic info + active/recording toggles
 *   3. Single source URL (edit inline, copy button)
 *   4. This channel's recorded segments (recent + searchable)
 *   5. This channel's clips (recent)
 */

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import Hls from 'hls.js';
import { toast } from 'sonner';
import {
  ArrowLeft, Camera, Copy, Check, Save, Loader2, Circle, CircleDot,
  Film, Scissors, Search,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { AuthImg } from '@/components/auth-img';
import { LogoUploader } from '@/components/channel-overview-panels';
import { api } from '@/lib/api';
import { SOURCE_KINDS, CHANNEL_CATEGORIES, CHANNEL_LANGUAGES } from '@cmc/shared';
import { cn, fmtBytes } from '@/lib/utils';

interface Source {
  id: string; channelId: string; name: string; url: string; kind: string;
  isPrimary: boolean; priority: number; notes: string | null;
}
interface Channel {
  id: string; slug: string; name: string; category: string; language: string; active: boolean;
  logoUrl: string | null;
  recordingEnabled: boolean;
  notes: string | null;
  sources: Source[];   // detail endpoint returns array; CMC uses [0] only
}
interface RecordingSegment {
  id: string; channelId: string; startedAt: string; durationMs: number;
  sizeBytes: number; path: string;
}
interface Clip {
  id: string; channelId: string; title: string; startAt: string; endAt: string;
  status: string; format: string; resolution: string; sizeBytes?: number;
}

export default function ChannelDetailPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const qc = useQueryClient();

  const { data: ch, isLoading } = useQuery<Channel>({
    queryKey: ['channel', id],
    queryFn: () => api<Channel>(`/api/channels/${id}`),
    refetchInterval: 10_000,
  });

  if (isLoading || !ch) {
    return <div className="max-w-[1400px] mx-auto"><div className="h-64 rounded-xl bg-panel2/70 animate-pulse" /></div>;
  }

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      {/* header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <button onClick={() => router.back()} className="text-muted hover:text-txt" title="Back">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-2xl font-bold tracking-tight">{ch.name}</h1>
              <Badge variant="brand">{ch.category}</Badge>
              <Badge variant="outline">{ch.language}</Badge>
              {ch.recordingEnabled && <Badge className="bg-accent-red/15 text-accent-red border-accent-red/30">RECORDING</Badge>}
            </div>
            <div className="text-[11px] text-muted-2 mt-0.5 font-mono uppercase tracking-widest">/{ch.slug}</div>
          </div>
        </div>
        <LogoUploader channelId={ch.id} currentUrl={ch.logoUrl} />
      </div>

      {/* live preview + snapshot */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <LivePreviewCard slug={ch.slug} channelId={ch.id} channelName={ch.name} />
        <InfoCard channel={ch} />
      </div>

      {/* single source */}
      <SourceCard channel={ch} onSaved={() => qc.invalidateQueries({ queryKey: ['channel', id] })} />

      {/* recordings + clips for this channel */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecordingsPanel channelId={ch.id} channelSlug={ch.slug} />
        <ClipsPanel channelId={ch.id} />
      </div>
    </div>
  );
}

/* ─────────────────────────────── Live HLS preview + snapshot ─────────── */

function LivePreviewCard({ slug, channelId, channelName }: { slug: string; channelId: string; channelName: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [muted, setMuted] = useState(true);
  const [status, setStatus] = useState<'loading' | 'playing' | 'error'>('loading');

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '')
      || `${window.location.protocol}//${window.location.hostname}:4001`;
    const url = `${base}/hls/${slug}/live.m3u8`;
    if (!Hls.isSupported() && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url; video.play().catch(() => {}); setStatus('playing');
      return;
    }
    if (hlsRef.current) hlsRef.current.destroy();
    const hls = new Hls({
      liveDurationInfinity: true, lowLatencyMode: false,
      liveSyncDurationCount: 3, liveMaxLatencyDurationCount: 40,
      maxBufferLength: 60, backBufferLength: 30,
    });
    hlsRef.current = hls;
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
    hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); setStatus('playing'); });
    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      setStatus('error');
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); setStatus('loading'); }
      else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); setStatus('loading'); }
    });
    return () => { hls.destroy(); hlsRef.current = null; };
  }, [slug]);

  useEffect(() => { if (videoRef.current) videoRef.current.muted = muted; }, [muted]);

  const snapshotMut = useMutation({
    mutationFn: () => api(`/api/channels/${channelId}/snapshot`, { method: 'POST', body: {} }),
    onSuccess: () => toast.success(`Frame saved — see Frames page`),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Snapshot failed'),
  });

  return (
    <Card className="lg:col-span-2 overflow-hidden">
      <div className="relative aspect-video bg-black">
        <video
          ref={videoRef}
          playsInline autoPlay muted
          className="w-full h-full"
          style={{ objectFit: 'cover' }}
        />
        {status !== 'playing' && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60 text-xs uppercase tracking-widest">
            {status === 'loading' ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> loading</> : 'no live signal'}
          </div>
        )}
      </div>
      <div className="p-3 flex items-center gap-2">
        <div className="text-xs text-muted">{channelName} · live</div>
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setMuted((m) => !m)} title={muted ? 'Unmute' : 'Mute'}>
            {muted ? 'Unmute audio' : 'Mute audio'}
          </Button>
          <Button
            size="sm"
            variant="gradient"
            onClick={() => snapshotMut.mutate()}
            disabled={snapshotMut.isPending}
            title="Capture the current frame → visible on Frames page"
          >
            {snapshotMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Camera className="h-3.5 w-3.5 mr-1" />}
            Snapshot
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ─────────────────────────────── Basic info + toggles ────────────────── */

function InfoCard({ channel: ch }: { channel: Channel }) {
  const qc = useQueryClient();
  const [name, setName] = useState(ch.name);
  const [category, setCategory] = useState(ch.category);
  const [language, setLanguage] = useState(ch.language);
  const [active, setActive] = useState(ch.active);
  const [recording, setRecording] = useState(ch.recordingEnabled);
  const [notes, setNotes] = useState(ch.notes ?? '');
  useEffect(() => {
    setName(ch.name); setCategory(ch.category); setLanguage(ch.language);
    setActive(ch.active); setRecording(ch.recordingEnabled); setNotes(ch.notes ?? '');
  }, [ch.name, ch.category, ch.language, ch.active, ch.recordingEnabled, ch.notes]);

  const saveMut = useMutation({
    mutationFn: (body: Partial<Channel>) => api(`/api/channels/${ch.id}`, { method: 'PATCH', body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel', ch.id] }); toast.success('Saved'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const dirty = name !== ch.name || category !== ch.category || language !== ch.language
    || active !== ch.active || recording !== ch.recordingEnabled || notes !== (ch.notes ?? '');

  return (
    <Card>
      <CardHeader><CardTitle>Info</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <label className="text-[10px] uppercase tracking-widest text-muted-2">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-2">Category</label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CHANNEL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-2">Language</label>
            <Select value={language} onValueChange={setLanguage}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CHANNEL_LANGUAGES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex gap-4">
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Active
          </label>
          <label className="inline-flex items-center gap-2 text-sm">
            <input type="checkbox" checked={recording} onChange={(e) => setRecording(e.target.checked)} />
            Recording
          </label>
        </div>
        <div>
          <label className="text-[10px] uppercase tracking-widest text-muted-2">Notes</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" />
        </div>
        <div className="pt-2">
          <Button
            size="sm" variant="gradient"
            onClick={() => saveMut.mutate({ name, category, language, active, recordingEnabled: recording, notes })}
            disabled={!dirty || saveMut.isPending}
          >
            {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────────── Single source (edit / copy) ─────────── */

function SourceCard({ channel: ch, onSaved }: { channel: Channel; onSaved: () => void }) {
  const current = ch.sources[0] ?? null;
  const [url, setUrl] = useState(current?.url ?? '');
  const [kind, setKind] = useState(current?.kind ?? 'UDP');
  const [copied, setCopied] = useState(false);
  useEffect(() => { setUrl(current?.url ?? ''); setKind(current?.kind ?? 'UDP'); }, [current?.url, current?.kind]);

  const upsertMut = useMutation({
    mutationFn: async () => {
      if (current) {
        return api(`/api/sources/${current.id}`, { method: 'PATCH', body: { url, kind } });
      }
      return api('/api/sources', { method: 'POST', body: { channelId: ch.id, name: ch.slug, url, kind, isPrimary: true } });
    },
    onSuccess: () => { onSaved(); toast.success('Source saved'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  async function copy() {
    if (!url) return;
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url); ok = true;
      }
    } catch { /* fall */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url; ta.style.position = 'fixed'; ta.style.left = '-1000px';
        document.body.appendChild(ta); ta.focus(); ta.select();
        ok = document.execCommand('copy'); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (ok) { setCopied(true); setTimeout(() => setCopied(false), 1200); }
    else    { toast.error('Copy failed — select and Ctrl+C'); }
  }

  const dirty = url !== (current?.url ?? '') || kind !== (current?.kind ?? 'UDP');

  return (
    <Card>
      <CardHeader><CardTitle>Source</CardTitle></CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 md:grid-cols-[8rem_1fr_auto] gap-2 items-end">
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-2">Kind</label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-widest text-muted-2">URL</label>
            <div className="flex items-center gap-1">
              <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="udp://@239.1.1.10:1111" className="font-mono text-xs" />
              <button
                onClick={copy}
                className={cn(
                  'shrink-0 rounded p-2 transition',
                  copied ? 'text-green-500' : 'text-muted-2 hover:text-txt hover:bg-panel2',
                )}
                title={copied ? 'Copied' : 'Copy URL'}
                disabled={!url}
              >
                {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
          </div>
          <Button
            size="sm" variant="gradient"
            onClick={() => upsertMut.mutate()}
            disabled={!dirty || !url || upsertMut.isPending}
          >
            {upsertMut.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/* ─────────────────────────────── Recordings / clips of this channel ──── */

function RecordingsPanel({ channelId, channelSlug }: { channelId: string; channelSlug: string }) {
  const now = new Date();
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    return fmtLocalDT(d);
  });
  const [to, setTo] = useState<string>(() => fmtLocalDT(now));
  const [q, setQ] = useState('');

  const { data, isLoading } = useQuery<RecordingSegment[]>({
    queryKey: ['channel.recordings', channelId, from, to],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('channelId', channelId);
      p.set('from', new Date(from).toISOString());
      p.set('to',   new Date(to).toISOString());
      p.set('limit', '500');
      return api<RecordingSegment[]>(`/api/recordings?${p}`);
    },
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => {
    const list = data ?? [];
    if (!q.trim()) return list;
    const term = q.trim().toLowerCase();
    return list.filter((r) => r.startedAt.toLowerCase().includes(term) || r.path.toLowerCase().includes(term));
  }, [data, q]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Film className="h-4 w-4 text-brand" /> Recordings</CardTitle>
        <Link href={`/recordings?channelId=${channelId}`} className="text-xs text-brand hover:underline">All →</Link>
      </CardHeader>
      <CardContent>
        <div className="mb-2 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="pl-9" />
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-2 uppercase tracking-widest text-[9px]">From</span>
            <input type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="h-8 px-2 flex-1 min-w-0 rounded-md border border-line bg-white font-mono text-xs" />
            <span className="text-muted-2 uppercase tracking-widest text-[9px]">To</span>
            <input type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)}
              className="h-8 px-2 flex-1 min-w-0 rounded-md border border-line bg-white font-mono text-xs" />
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto scrollbar-thin divide-y divide-line -mx-3">
          {isLoading && <div className="p-3 text-xs text-muted-2">Loading…</div>}
          {!isLoading && rows.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-2">
              No segments in this window for <span className="font-mono">{channelSlug}</span>.
            </div>
          )}
          {rows.map((r) => (
            <div key={r.id} className="px-3 py-2 flex items-center justify-between text-xs">
              <div className="flex-1 min-w-0">
                <div className="font-medium">{new Date(r.startedAt).toLocaleString()}</div>
                <div className="text-[10px] text-muted-2 font-mono truncate">{r.path.split(/[\\/]/).slice(-1)[0]}</div>
              </div>
              <div className="text-right shrink-0 ml-3">
                <div className="text-muted">{fmtBytes(r.sizeBytes)}</div>
                <div className="text-[10px] text-muted-2">{Math.round(r.durationMs / 1000)}s</div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ClipsPanel({ channelId }: { channelId: string }) {
  const now = new Date();
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(now); d.setDate(d.getDate() - 30);
    return fmtLocalDT(d);
  });
  const [to, setTo] = useState<string>(() => fmtLocalDT(now));
  const [q, setQ] = useState('');
  const { data, isLoading } = useQuery<Clip[]>({
    queryKey: ['channel.clips', channelId, from, to],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('channelId', channelId);
      p.set('from', new Date(from).toISOString());
      p.set('to',   new Date(to).toISOString());
      p.set('limit', '500');
      return api<Clip[]>(`/api/clips?${p}`);
    },
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => {
    const list = data ?? [];
    if (!q.trim()) return list;
    const term = q.trim().toLowerCase();
    return list.filter((c) =>
      c.title.toLowerCase().includes(term) ||
      c.startAt.toLowerCase().includes(term) ||
      c.status.toLowerCase().includes(term),
    );
  }, [data, q]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Scissors className="h-4 w-4 text-brand" /> Clips</CardTitle>
        <Link href={`/clips?channelId=${channelId}`} className="text-xs text-brand hover:underline">All →</Link>
      </CardHeader>
      <CardContent>
        <div className="mb-2 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="pl-9" />
          </div>
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-2 uppercase tracking-widest text-[9px]">From</span>
            <input type="datetime-local" value={from} max={to} onChange={(e) => setFrom(e.target.value)}
              className="h-8 px-2 flex-1 min-w-0 rounded-md border border-line bg-white font-mono text-xs" />
            <span className="text-muted-2 uppercase tracking-widest text-[9px]">To</span>
            <input type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)}
              className="h-8 px-2 flex-1 min-w-0 rounded-md border border-line bg-white font-mono text-xs" />
          </div>
        </div>
        <div className="max-h-80 overflow-y-auto scrollbar-thin divide-y divide-line -mx-3">
          {isLoading && <div className="p-3 text-xs text-muted-2">Loading…</div>}
          {!isLoading && rows.length === 0 && (
            <div className="p-4 text-center text-xs text-muted-2">No clips yet.</div>
          )}
          {rows.map((c) => (
            <Link key={c.id} href={`/clips/${c.id}`} className="block px-3 py-2 hover:bg-panel2 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-medium truncate">{c.title}</div>
                <Badge variant="outline" className="text-[9px] px-1 py-0">{c.status}</Badge>
              </div>
              <div className="text-[10px] text-muted-2 mt-0.5">
                {new Date(c.startAt).toLocaleString()} · {c.resolution} · {c.format}{c.sizeBytes ? ` · ${fmtBytes(c.sizeBytes)}` : ''}
              </div>
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Kept references so lint doesn't drop unused imports:
void AuthImg;
void Circle; void CircleDot;

/** ISO-ish local datetime "YYYY-MM-DDTHH:mm" — the shape a
 *  `<input type="datetime-local">` control both emits and accepts. */
function fmtLocalDT(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
