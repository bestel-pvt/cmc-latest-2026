'use client';

/**
 * Clip Editor — single-view HLS player + timeline with in/out markers.
 *
 * Loads the WHOLE recording session (start → stop) as an HLS stream so
 * the operator can start playing in ~1 s no matter how long the
 * session is, and seek instantly to any point (hls.js pulls only the
 * segments it needs). Mark in / mark out on the timeline; export sends
 * the resolved absolute timestamps to /api/clips.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowLeft, Play, Pause, ChevronsLeft, ChevronsRight,
  Rewind, FastForward, Download, Save, Loader2, Volume2, VolumeX,
  Split, ArrowRightToLine, ArrowLeftToLine,
} from 'lucide-react';
import Link from 'next/link';
import Hls from 'hls.js';
import WaveSurfer from 'wavesurfer.js';
import { toast } from 'sonner';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { api } from '@/lib/api';
import { CLIP_FORMATS, CLIP_RESOLUTIONS } from '@cmc/shared';
import { fmtTimeCode } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface Channel { id: string; name: string; slug: string }
interface Segment { id: string; startedAt: string; durationMs: number; path: string; channelId: string }

export default function NewClipPage() {
  const router = useRouter();
  const sp = useSearchParams();
  const user = useAuth((s) => s.user);
  const channelId = sp.get('channelId') ?? '';
  // Two entry paths: (a) recording session start/end, (b) single segmentId.
  const sessionStart = sp.get('sessionStart');
  const sessionEnd = sp.get('sessionEnd');
  const segmentId = sp.get('segmentId');

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const waveRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);

  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [markOut, setMarkOut] = useState<number | null>(null);
  // Absolute wall-clock ms captured at mark-press via
  // `hls.playingDate` — that reflects the CURRENT fragment's PDT
  // anchor (server now emits PDT at every DISCONTINUITY), so it
  // stays accurate over hour-long sessions where EXTINF-based
  // extrapolation would drift by tens of seconds (HUM News clip
  // regression 2026-08-25). `startAtISO` prefers these when set
  // and falls back to `playlistStartMs + markIn*1000` otherwise.
  const [markInMs, setMarkInMs] = useState<number | null>(null);
  const [markOutMs, setMarkOutMs] = useState<number | null>(null);
  // Wall-clock time of the video's frame 0 — populated from the
  // manifest's first PDT tag on MANIFEST_PARSED. Only used as an
  // anchor when hls.playingDate isn't available (Safari native HLS).
  const [playlistStartMs, setPlaylistStartMs] = useState<number | null>(null);
  // Ref mirror so `captureMark` always reads the latest value —
  // captureMark is called from a keydown handler installed inside a
  // useEffect with `[totalSeconds]` deps, so a plain closure over
  // playlistStartMs would freeze at whatever it was when the handler
  // was installed. Ref sidesteps that.
  const playlistStartMsRef = useRef<number | null>(null);
  useEffect(() => { playlistStartMsRef.current = playlistStartMs; }, [playlistStartMs]);
  // Current playing fragment's PDT + start (video.currentTime at fragment
  // start). Copy-mode recording segments have variable actual durations
  // (60-70 s per keyframe cadence) but the playlist declares uniform
  // 60-s EXTINFs — so `firstFragmentPDT + v.currentTime` drifts by
  // seconds after 3-4 fragments. Per-fragment PDT lets us anchor to the
  // TRUE wall time at any playback point. Reported 2026-09-02 on abb-tak
  // (interlaced PAL, copy-mode) where a 3-min-in mark landed correctly
  // in the first-fragment case but drifted for later marks.
  const currentFragRef = useRef<{ pdt: number; start: number } | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);

  // Discrete video-load state so the user sees WHY the frame is dark
  // instead of a silent aspect-ratio placeholder. 'error' surfaces the
  // real HTTP status from the manifest endpoint, not hls.js's generic
  // "manifestLoadError" wording.
  const [videoState, setVideoState] = useState<
    { kind: 'idle' } |
    { kind: 'loading'; step: string } |
    { kind: 'ready' } |
    { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [waveState, setWaveState] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  // Separate flag for "buffering after a seek". videoState transitions
  // to 'ready' after the initial manifest parse and never flips back to
  // 'loading' on seeks — so without this the player looks completely
  // frozen when you click a timeline point that isn't buffered yet.
  const [seekBuffering, setSeekBuffering] = useState(false);

  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [format, setFormat] = useState<'MP4' | 'MOV' | 'MKV' | 'WEBM'>('MP4');
  const [resolution, setResolution] = useState('1920x1080');

  // If the operator arrived from a session ("Create clip" on the
  // Recordings page), we already have startedAt/endedAt. If they arrived
  // from a single segment link, look it up to get channelId + startedAt
  // and treat it as a 1-segment window.
  const { data: segment } = useQuery<Segment>({
    queryKey: ['clipseg', segmentId],
    queryFn: () => api<Segment>(`/api/recordings/${segmentId}`),
    enabled: !!segmentId && (!sessionStart || !sessionEnd),
  });
  const { data: channels } = useQuery<Channel[]>({
    queryKey: ['channels.for-clip'],
    queryFn: () => api<Channel[]>('/api/channels'),
  });
  const channel = useMemo(() => channels?.find((c) => c.id === channelId), [channels, channelId]);

  const effectiveStart = sessionStart ?? segment?.startedAt ?? null;
  const effectiveEnd = sessionEnd ?? (segment
    ? new Date(new Date(segment.startedAt).getTime() + segment.durationMs).toISOString()
    : null);

  // Attach hls.js pointing at the session playlist. Restart the player
  // whenever channel/session window changes. Probe the manifest URL
  // ourselves FIRST so a 404 / 401 / 500 surfaces with an actionable
  // message instead of hls.js's opaque "manifestLoadError".
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !channelId || !effectiveStart || !effectiveEnd) return;
    const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
    const p = new URLSearchParams();
    p.set('channelId', channelId);
    p.set('from', effectiveStart);
    p.set('to',   effectiveEnd);
    const src = `${API_BASE}/api/recordings/session.m3u8?${p}`;

    let hls: Hls | null = null;
    let cancelled = false;

    (async () => {
      setVideoState({ kind: 'loading', step: 'Checking recording…' });
      // Probe: gives us the REAL failure reason (no segments, expired
      // token, server down) so the video panel doesn't just show "error"
      // with hls.js's opaque code.
      try {
        const probe = await fetch(src, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (cancelled) return;
        if (!probe.ok) {
          const body = await probe.text().catch(() => '');
          const parsed = (() => { try { return JSON.parse(body) as { message?: string; error?: string }; } catch { return null; } })();
          const detail = parsed?.message ?? parsed?.error ?? body.slice(0, 160);
          const message =
            probe.status === 401 ? 'Session expired — please sign in again.' :
            probe.status === 404 ? (detail || 'No playable segments in this recording window.') :
            probe.status >= 500  ? `Server error while assembling playlist${detail ? ` — ${detail}` : ''}.` :
                                    `HTTP ${probe.status}${detail ? ` — ${detail}` : ''}`;
          setVideoState({ kind: 'error', message });
          return;
        }
      } catch (err) {
        if (cancelled) return;
        setVideoState({ kind: 'error', message: `Network error reaching the recording server${err instanceof Error ? ` (${err.message})` : ''}.` });
        return;
      }

      if (cancelled) return;
      setVideoState({ kind: 'loading', step: 'Buffering first frames…' });

      if (Hls.isSupported()) {
        hls = new Hls({
          xhrSetup: (xhr) => { if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`); },
          // Small buffer bump vs the old 12 s live-style config:
          // 30 s ahead / 30 s back so a slice-generation blip (the
          // ~500 ms wait when hls.js crosses into an un-batched 60 s
          // segment) doesn't force a mid-play stall. Also stops
          // audio-track from advancing ahead of video during any
          // brief buffer emptying — with 12 s buffer, audio would
          // drain slower than video (video is bigger), so on stall
          // the tracks separated visibly. 30 s buffer + smaller
          // maxBufferHole keeps them tight.
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          backBufferLength: 30,
          maxBufferSize: 24 * 1024 * 1024,
          maxBufferHole: 0.1,
          startFragPrefetch: true,
          lowLatencyMode: false,
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (data.fatal) {
            setVideoState({ kind: 'error', message: `${data.type} — ${data.details}` });
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          setVideoState({ kind: 'ready' });
          // Grab PDT from the first fragment so absolute startAt/endAt
          // computation is anchored to the true playlist start time.
          const frag = hls?.levels?.[0]?.details?.fragments?.[0];
          const pdt = frag?.programDateTime;
          if (typeof pdt === 'number' && !Number.isNaN(pdt)) setPlaylistStartMs(pdt);
          // Seed the current-fragment ref too so a mark before FRAG_CHANGED
          // fires still gets accurate PDT (fragment 0 is trivially current).
          if (frag && typeof frag.programDateTime === 'number' && typeof frag.start === 'number') {
            currentFragRef.current = { pdt: frag.programDateTime, start: frag.start };
          }
        });
        // Track the currently-playing fragment. Each fragment carries its
        // own PDT from the session playlist (re-anchored at every
        // discontinuity). Using the CURRENT fragment's PDT + offset
        // within that fragment gives frame-accurate wall time even when
        // the playlist's declared EXTINF durations differ from the
        // physical MP4 segment durations (copy-mode drift).
        hls.on(Hls.Events.FRAG_CHANGED, (_e, data) => {
          const f = data?.frag;
          if (f && typeof f.programDateTime === 'number' && typeof f.start === 'number') {
            currentFragRef.current = { pdt: f.programDateTime, start: f.start };
          }
        });
        hls.loadSource(src);
        hls.attachMedia(video);
        hlsRef.current = hls;
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        setVideoState({ kind: 'ready' });
      } else {
        setVideoState({ kind: 'error', message: 'This browser cannot play HLS.' });
      }
    })();

    return () => { cancelled = true; hls?.destroy(); };
  }, [channelId, effectiveStart, effectiveEnd]);

  // Waveform (peaks fetched from the API — server pre-computes them
  // from the session's segments so we don't need to send raw audio to
  // the browser).
  useEffect(() => {
    if (!waveRef.current || !channelId || !effectiveStart || !effectiveEnd) return;
    let cancelled = false;
    setWaveState('loading');
    const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
    const p = new URLSearchParams();
    p.set('channelId', channelId);
    p.set('from', effectiveStart);
    p.set('to',   effectiveEnd);
    (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/recordings/session-peaks.json?${p}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!r.ok) throw new Error(`peaks HTTP ${r.status}`);
        const { peaks, duration: dur } = await r.json() as { peaks: number[]; duration: number };
        if (cancelled || !waveRef.current) return;
        wsRef.current?.destroy();
        const ws = WaveSurfer.create({
          container: waveRef.current,
          waveColor: 'rgba(100, 116, 139, 0.35)',
          progressColor: '#15803D',
          cursorColor: '#E11D48',
          cursorWidth: 2,
          height: 64,
          barWidth: 2,
          barGap: 1,
          barRadius: 2,
          normalize: true,
          interact: true,
          peaks: [peaks],
          duration: dur,
          media: videoRef.current ?? undefined,
        });
        wsRef.current = ws;
        setWaveState('ready');
      } catch (e) {
        // Fallback: no waveform, still render the flat click-to-seek strip below.
        console.warn('waveform load failed:', e);
        setWaveState('failed');
      }
    })();
    return () => { cancelled = true; wsRef.current?.destroy(); wsRef.current = null; };
  }, [channelId, effectiveStart, effectiveEnd]);

  // Wire video events
  useEffect(() => {
    const v = videoRef.current; if (!v) return;
    const onMeta = () => setDuration(v.duration || 0);
    const onTime = () => setCurrent(v.currentTime);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    return () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
    };
  }, []);

  // Fallback total when the browser hasn't reported duration yet
  const totalSeconds = duration
    || (effectiveStart && effectiveEnd
      ? (new Date(effectiveEnd).getTime() - new Date(effectiveStart).getTime()) / 1000
      : 0);

  // Snapshot a mark point in BOTH forms at press-time:
  //   - `seconds`: raw `v.currentTime`, drives the visible
  //     progress-bar labels and length display
  //   - `absMs`: deterministic — first-fragment PDT (frame-0 wall
  //     clock) + video.currentTime. `hls.playingDate` was tried
  //     first but returned wrong values on multi-fragment sessions
  //     with per-boundary PDT (an 88-s clip export from a 38-s mark
  //     on 2026-08-27), so we no longer trust it and instead
  //     compute the offset ourselves against the known-good anchor.
  const captureMark = (v: HTMLVideoElement | null) => {
    if (!v) return { seconds: 0, absMs: null as number | null };
    const seconds = Math.max(0, v.currentTime);
    // Prefer per-fragment PDT: currentFragPDT + (v.currentTime - fragStart).
    // Falls back to first-PDT anchor + full currentTime when no fragment
    // info is available (Safari native HLS, pre-FRAG_CHANGED).
    const cur = currentFragRef.current;
    let absMs: number | null = null;
    if (cur) {
      absMs = cur.pdt + Math.round((seconds - cur.start) * 1000);
    } else {
      const anchor = playlistStartMsRef.current;
      absMs = anchor !== null ? anchor + Math.round(seconds * 1000) : null;
    }
    return { seconds, absMs };
  };
  const setIn  = (v: HTMLVideoElement | null) => { const m = captureMark(v); setMarkIn(m.seconds);  setMarkInMs(m.absMs); };
  const setOut = (v: HTMLVideoElement | null) => { const m = captureMark(v); setMarkOut(m.seconds); setMarkOutMs(m.absMs); };
  const sessionSecondsAt = (v: HTMLVideoElement | null): number => {
    if (!v) return 0;
    return Math.max(0, v.currentTime);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const v = videoRef.current; if (!v) return;
      if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
      if (e.key === 'i' || e.key === 'I') setIn(v);
      if (e.key === 'o' || e.key === 'O') setOut(v);
      if (e.key === 'k') v.pause();
      if (e.key === 'ArrowLeft')  v.currentTime = Math.max(0, v.currentTime - (e.shiftKey ? 5 : 0.5));
      if (e.key === 'ArrowRight') v.currentTime = Math.min(totalSeconds, v.currentTime + (e.shiftKey ? 5 : 0.5));
      if (e.key === 'Home') v.currentTime = 0;
      if (e.key === 'End')  v.currentTime = totalSeconds;
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [totalSeconds]);

  const anchorMs = useMemo(() => {
    if (playlistStartMs !== null) return playlistStartMs;
    if (effectiveStart) return new Date(effectiveStart).getTime();
    return null;
  }, [playlistStartMs, effectiveStart]);

  const startAtISO = useMemo(() => {
    if (markInMs !== null) return new Date(markInMs).toISOString();
    if (anchorMs === null || markIn === null) return null;
    return new Date(anchorMs + markIn * 1000).toISOString();
  }, [anchorMs, markIn, markInMs]);

  const endAtISO = useMemo(() => {
    if (markOutMs !== null) return new Date(markOutMs).toISOString();
    if (anchorMs === null || markOut === null) return null;
    return new Date(anchorMs + markOut * 1000).toISOString();
  }, [anchorMs, markOut, markOutMs]);

  const canExport = !!(title && channelId && startAtISO && endAtISO && markOut !== null && markIn !== null && markOut > markIn);

  const exportMut = useMutation({
    mutationFn: () => api('/api/clips', {
      method: 'POST',
      body: {
        channelId, title, notes,
        startAt: startAtISO, endAt: endAtISO,
        // Format + resolution are locked to MP4 / 1920x1080 — the
        // operator UI no longer surfaces the dropdowns. Server still
        // accepts the fields for back-compat.
        format: 'MP4', resolution: '1920x1080',
        watermarkText: `${user?.email ?? 'unknown'} - ${new Date().toISOString()}`,
      },
    }),
    onSuccess: () => { toast.success('Clip queued'); router.push('/clips'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Export failed'),
  });

  const inPct  = markIn !== null && totalSeconds ? (markIn / totalSeconds) * 100 : null;
  const outPct = markOut !== null && totalSeconds ? (markOut / totalSeconds) * 100 : null;
  const curPct = totalSeconds ? (current / totalSeconds) * 100 : 0;

  // Landing view when the URL has neither ?segmentId= nor ?sessionStart=
  if (!segmentId && !(sessionStart && sessionEnd)) {
    return <RecordingPicker />;
  }

  return (
    <div className="max-w-[1400px] mx-auto space-y-4">
      {/* top bar */}
      <div className="flex items-center gap-3">
        <Link href="/clips" className="text-muted hover:text-txt"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="flex-1">
          <h1 className="font-display text-2xl font-bold tracking-tight">Clip Editor</h1>
          <p className="text-xs text-muted mt-0.5">
            {channel?.name ?? 'Loading channel…'} · {effectiveStart ? new Date(effectiveStart).toLocaleString() : ''}
          </p>
        </div>
        <Button variant="secondary" onClick={() => toast.info('Drafts land in Phase 2.')}>
          <Save className="h-4 w-4" /> Save draft
        </Button>
        <Button variant="gradient" onClick={() => exportMut.mutate()} disabled={!canExport || exportMut.isPending}>
          {exportMut.isPending ? <Loader2 className="animate-spin h-4 w-4" /> : <Download className="h-4 w-4" />}
          Export MP4
        </Button>
      </div>

      {/* single video view + inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-4">
        <Card className="p-3">
          <div className="relative aspect-video rounded-md overflow-hidden bg-ink border border-border">
            <video
              ref={videoRef}
              className="absolute inset-0 h-full w-full"
              playsInline
              muted={muted}
              onClick={() => { const v = videoRef.current; if (!v) return; v.paused ? v.play() : v.pause(); }}
              onWaiting={() => setSeekBuffering(true)}
              onSeeking={() => setSeekBuffering(true)}
              onPlaying={() => setSeekBuffering(false)}
              onCanPlay={() => setSeekBuffering(false)}
              onPause={() => setSeekBuffering(false)}
              onSeeked={() => {
                // Some browsers fire 'seeked' before the frame is actually
                // decoded; leave the spinner up until 'playing' or
                // 'canplay' fires so the operator never sees a stall
                // that looks like a hang.
              }}
            />
            {videoState.kind === 'ready' && seekBuffering && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-ink/40 text-[11px] text-white/80 pointer-events-none">
                <Loader2 className="h-6 w-6 animate-spin text-brand" />
                <div>Loading…</div>
              </div>
            )}
            {videoState.kind === 'loading' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink/80 text-sm text-white/80 pointer-events-none">
                <Loader2 className="h-6 w-6 animate-spin text-brand" />
                <div>{videoState.step}</div>
              </div>
            )}
            {videoState.kind === 'error' && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink/90 px-6 text-center text-sm">
                <div className="text-accent-red font-semibold">Can&apos;t load this recording</div>
                <div className="text-white/80 text-xs max-w-md">{videoState.message}</div>
                <div className="text-white/40 text-[10px] mt-2">
                  If the recorder just started, wait ~60 s for the first segment to close. Otherwise reach out to support.
                </div>
              </div>
            )}
          </div>
        </Card>

        <Card className="p-4 space-y-4">
          <div>
            <Label>Title</Label>
            <Input required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Breaking · headline moment" />
          </div>
          <div>
            <Label>Notes</Label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="mt-1.5 w-full rounded-md border border-border bg-panel2/50 p-2 text-sm resize-none"
            />
          </div>
          {/* Format + Resolution locked to MP4 1080p — dropdowns removed. */}
          <div className="pt-2 border-t border-border">
            <div className="text-[10px] uppercase tracking-widest text-muted-2 mb-2">Watermark</div>
            <div className="font-mono text-[11px] text-muted break-all">{user?.email} - {new Date().toISOString().slice(0, 19)}Z</div>
            <p className="text-[10px] text-muted-2 mt-1">Burned into the exported file. Cannot be disabled.</p>
          </div>
          <div className="pt-2 border-t border-border">
            <div className="text-[10px] uppercase tracking-widest text-muted-2 mb-1">Clip window</div>
            <div className="font-mono text-[11px]">
              <div>in  <span className="text-accent-green">{markIn === null ? '—' : fmtTimeCode(markIn)}</span></div>
              <div>out <span className="text-accent-red">{markOut === null ? '—' : fmtTimeCode(markOut)}</span></div>
              <div className="text-muted-2 mt-0.5">
                length {markIn !== null && markOut !== null && markOut > markIn ? fmtTimeCode(markOut - markIn) : '—'}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* timeline + transport */}
      <Card className="p-3 space-y-3">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" onClick={() => { const v = videoRef.current!; v.currentTime = 0; }} title="Start (Home)"><ChevronsLeft /></Button>
          <Button variant="ghost" size="icon" onClick={() => { const v = videoRef.current!; v.currentTime = Math.max(0, v.currentTime - 5); }} title="- 5s"><Rewind /></Button>
          <Button variant="secondary" size="icon" onClick={() => { const v = videoRef.current!; v.paused ? v.play() : v.pause(); }} title="Play/Pause (Space)">
            {playing ? <Pause /> : <Play />}
          </Button>
          <Button variant="ghost" size="icon" onClick={() => { const v = videoRef.current!; v.currentTime = Math.min(totalSeconds, v.currentTime + 5); }} title="+ 5s"><FastForward /></Button>
          <Button variant="ghost" size="icon" onClick={() => { const v = videoRef.current!; v.currentTime = totalSeconds; }} title="End"><ChevronsRight /></Button>

          <div className="mx-3 h-6 w-px bg-border" />

          <Button variant="secondary" size="sm" onClick={() => setIn(videoRef.current)} title="Mark in (I)">
            <ArrowLeftToLine className="h-4 w-4" /> Mark in
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setOut(videoRef.current)} title="Mark out (O)">
            Mark out <ArrowRightToLine className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => { setMarkIn(null); setMarkOut(null); setMarkInMs(null); setMarkOutMs(null); }}>
            <Split className="h-4 w-4" /> Clear
          </Button>

          <div className="ml-auto flex items-center gap-3 pr-2 font-mono text-xs">
            <Button variant="ghost" size="icon" onClick={() => setMuted((m) => { const v = videoRef.current; if (v) v.muted = !m; return !m; })}>
              {muted ? <VolumeX /> : <Volume2 />}
            </Button>
            <div className="text-muted">
              <span className="text-txt">{fmtTimeCode(current)}</span> / {fmtTimeCode(totalSeconds)}
            </div>
          </div>
        </div>

        {/* Waveform + in/out overlay. WaveSurfer handles the click-to-seek
            interaction; we paint the in/out shading and marker triangles
            on top with pointer-events-none so it stays clickable. */}
        <div className="relative rounded-md border border-border bg-panel2/40 overflow-hidden">
          <div ref={waveRef} className="h-16" />
          {waveState === 'loading' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-[11px] text-muted-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading waveform…
            </div>
          )}
          {waveState === 'failed' && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] text-muted-2">
              Waveform unavailable — timeline still clickable for seek.
            </div>
          )}
          {inPct !== null  && <div className="pointer-events-none absolute inset-y-0 left-0 bg-ink/60" style={{ width: `${inPct}%` }} />}
          {outPct !== null && <div className="pointer-events-none absolute inset-y-0 right-0 bg-ink/60" style={{ width: `${100 - outPct}%` }} />}
          <div className="pointer-events-none absolute inset-y-0 border-l-2 border-brand" style={{ left: `${curPct}%` }} />
          {inPct !== null && (
            <div className="pointer-events-none absolute inset-y-0 border-l-2 border-accent-green" style={{ left: `${inPct}%` }}>
              <div className="absolute top-1 -left-2 h-2.5 w-2.5 rotate-45 bg-accent-green" />
            </div>
          )}
          {outPct !== null && (
            <div className="pointer-events-none absolute inset-y-0 border-l-2 border-accent-red" style={{ left: `${outPct}%` }}>
              <div className="absolute top-1 -left-2 h-2.5 w-2.5 rotate-45 bg-accent-red" />
            </div>
          )}
        </div>

        <div className="flex items-center gap-3 text-[10px] text-muted-2 uppercase tracking-widest">
          <span><span className="kbd">Space</span> play/pause</span>
          <span><span className="kbd">I</span>/<span className="kbd">O</span> in/out</span>
          <span><span className="kbd">Shift+←/→</span> ± 5s</span>
          <span><span className="kbd">←/→</span> ± 0.5s</span>
          <span><span className="kbd">Home</span>/<span className="kbd">End</span> jump</span>
        </div>
      </Card>
    </div>
  );
}

/**
 * Landing view when /clips/new has no context — pick a channel + date
 * + specific recording session before jumping into the editor.
 */
function RecordingPicker() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [channelId, setChannelId] = useState<string>('all');
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState<string>(today);
  const [q, setQ] = useState('');

  interface PickChannel { id: string; name: string; slug: string }
  interface Session {
    id: string; channelId: string; startedAt: string; endedAt: string;
    durationMs: number; sizeBytes: string; segmentCount: number;
    firstSegmentId: string;
    channel: { id: string; name: string; slug: string };
  }

  const { data: channels } = useQuery<PickChannel[]>({
    queryKey: ['channels.picker'],
    queryFn: () => api<PickChannel[]>('/api/channels'),
    staleTime: 60_000,
  });
  const { data: sessions } = useQuery<Session[]>({
    queryKey: ['picker.sessions', channelId, from, to],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('from', new Date(from + 'T00:00:00Z').toISOString());
      p.set('to',   new Date(to   + 'T23:59:59Z').toISOString());
      if (channelId !== 'all') p.set('channelId', channelId);
      p.set('limit', '500');
      return api<Session[]>(`/api/recordings/sessions?${p}`);
    },
  });

  const filtered = useMemo(() => {
    if (!q.trim()) return sessions ?? [];
    const needle = q.toLowerCase();
    return (sessions ?? []).filter((s) =>
      s.channel.name.toLowerCase().includes(needle) ||
      s.channel.slug.toLowerCase().includes(needle));
  }, [sessions, q]);

  return (
    <div className="max-w-[1300px] mx-auto space-y-4">
      <div className="flex items-center gap-3">
        <Link href="/clips" className="text-muted hover:text-txt"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="flex-1">
          <h1 className="font-display text-2xl font-bold tracking-tight">New Clip</h1>
          <p className="text-xs text-muted mt-0.5">Pick a recording, mark in/out, export with PAK NAVY watermark burned in.</p>
        </div>
      </div>

      <Card className="p-3">
        <div className="flex items-center gap-2 flex-wrap text-xs">
          <div className="relative flex-1 min-w-[240px]">
            <input value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search channel"
              className="w-full h-9 pl-3 rounded-md border border-line bg-white text-sm" />
          </div>
          <Select value={channelId} onValueChange={setChannelId}>
            <SelectTrigger className="w-52 h-9"><SelectValue /></SelectTrigger>
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
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-sm text-muted">No recordings match. Widen the date range or clear filters.</div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin">
            <table className="w-full text-sm">
              <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
                <tr>
                  <th className="text-left px-4 py-2">Channel</th>
                  <th className="text-left px-4 py-2">Started</th>
                  <th className="text-left px-4 py-2">Duration</th>
                  <th className="text-left px-4 py-2">Segments</th>
                  <th className="px-4 py-2 w-32"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((s) => {
                  const started = new Date(s.startedAt);
                  return (
                    <tr key={s.id} className="hover:bg-panel/40">
                      <td className="px-4 py-2.5 font-medium">{s.channel.name}</td>
                      <td className="px-4 py-2.5 font-mono text-xs">
                        {started.toLocaleString(undefined, { hour12: false })}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs">{fmtTimeCode(s.durationMs / 1000)}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-muted-2">{s.segmentCount}</td>
                      <td className="px-4 py-2.5">
                        <Button size="sm" variant="gradient"
                          onClick={() => router.push(
                            `/clips/new?channelId=${s.channelId}` +
                            `&sessionStart=${encodeURIComponent(s.startedAt)}` +
                            `&sessionEnd=${encodeURIComponent(s.endedAt)}`,
                          )}
                        >
                          Open editor →
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
