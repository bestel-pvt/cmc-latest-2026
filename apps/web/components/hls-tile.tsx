'use client';

/**
 * A single HLS-playback tile for the multiviewer wall.
 *
 * Reuses one hls.js instance per tile and swaps sources when the
 * `channelSlug` prop changes so a template load doesn't tear down
 * and rebuild every player. Muted by default and controls hidden —
 * this is a monitoring surface, not an ergonomic desktop player.
 */

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { X, Volume2, VolumeX } from 'lucide-react';
import { cn } from '@/lib/utils';

interface HlsTileProps {
  slug: string | null;
  channelName?: string | null;
  logoUrl?: string | null;
  /** Global audio state — tile is unmuted only when this matches this
   * tile's id. Parent tracks which slot has audio so we can enforce
   * "only one channel makes noise at a time". */
  audioActive: boolean;
  /** Called when the user clicks the volume icon on this tile. Parent
   * flips the global audio slot: click a muted tile → this becomes
   * active; click the active tile → all mute. */
  onToggleAudio: () => void;
  onClear?: () => void;
  onPick?: () => void;
  /** Double-click on a filled tile → parent switches the wall into a
   * solo/fullscreen view of just this channel. See the wall page's
   * `enterSolo` for the layout snapshot + Esc-restore flow. */
  onDoubleClick?: () => void;
  className?: string;
}

/**
 * The API serves HLS at `<api-host>/hls/<slug>/live.m3u8`. We prefer
 * NEXT_PUBLIC_API_URL (baked at build time), but if it's empty or
 * absent — which happens the first time the web is built without the
 * env being loaded — fall back to the SAME hostname the browser
 * loaded the page from, on port 4001. That makes the wall keep
 * working even when a rebuild forgot to pipe the env var through.
 */
function hlsUrl(slug: string): string {
  let base = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\/+$/, '');
  if (!base && typeof window !== 'undefined') {
    base = `${window.location.protocol}//${window.location.hostname}:4001`;
  }
  return `${base}/hls/${slug}/live.m3u8`;
}

export function HlsTile({
  slug,
  channelName,
  logoUrl,
  audioActive,
  onToggleAudio,
  onClear,
  onPick,
  onDoubleClick,
  className,
}: HlsTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  // Bumped by the stall watchdog and by "give up" fatal errors to
  // force the effect to fully re-mount hls.js — same effect as the
  // operator pressing R on that one tile, but automatic and only
  // fires when the tile is genuinely stuck.
  const [remountNonce, setRemountNonce] = useState(0);
  // Reset the nonce whenever the assigned slug changes so a fresh
  // channel starts from a clean recovery count.
  useEffect(() => { setRemountNonce(0); }, [slug]);

  /** Single vs. double click disambiguation. A DOM `click` fires as
   * part of a `dblclick` too, so we delay the single-click action by
   * ~220 ms — if a second click arrives inside that window we cancel
   * the timer and let dblclick handle it. Live-tuned: 220 ms is short
   * enough to feel instant for audio-toggle, long enough that no
   * accidental single-click fires before a genuine double.
   *
   * Cleared on unmount to avoid firing on a torn-down tile. */
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current);
  }, []);

  function handleTileClick(): void {
    if (!slug) return;                   // empty slot uses its own + Add button
    if (clickTimerRef.current) return;   // already waiting for a possible double
    clickTimerRef.current = setTimeout(() => {
      clickTimerRef.current = null;
      onToggleAudio();
    }, 220);
  }
  function handleTileDoubleClick(): void {
    if (!slug || !onDoubleClick) return;
    if (clickTimerRef.current) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
    onDoubleClick();
  }

  // Attach / re-attach the HLS source when the assigned channel changes.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // Empty slot: fully release the hls.js instance so we're not
    // fetching a playlist we no longer show.
    if (!slug) {
      if (hlsRef.current) { hlsRef.current.destroy(); hlsRef.current = null; }
      video.removeAttribute('src');
      video.load();
      setStatus('idle');
      return;
    }

    setStatus('loading');
    const url = hlsUrl(slug);

    // Safari can play HLS natively — skip hls.js there.
    if (!Hls.isSupported() && video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(() => {});
      setStatus('playing');
      return;
    }

    if (hlsRef.current) { hlsRef.current.destroy(); }
    const hls = new Hls({
      // User accepts high latency in exchange for zero stalls.
      // 6 s segments × liveSyncDurationCount 3 = start ~18 s behind live.
      // Then a big forward buffer (120 s) fills in background so any
      // network hiccup up to a couple of minutes is invisible.
      liveDurationInfinity: true,
      lowLatencyMode: false,
      liveSyncDurationCount: 3,
      liveMaxLatencyDurationCount: 40,     // let latency drift up to ~4 minutes before catching up
      maxBufferLength: 120,                // 2 min forward buffer
      maxMaxBufferLength: 240,             // 4 min ceiling
      backBufferLength: 60,                // 1 min back-buffer
      maxLiveSyncPlaybackRate: 1.05,       // gentle 5% catch-up if drifting
      fragLoadingMaxRetry: 8,              // 8 retries per segment
      fragLoadingRetryDelay: 500,
      levelLoadingMaxRetry: 6,
      manifestLoadingMaxRetry: 6,
    });
    hlsRef.current = hls;
    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
      setStatus('playing');
    });
    // Track when we last saw video.currentTime advance. If it stays
    // frozen for >20 s the tile is stuck (hls.js buffer went empty,
    // an internal fatal fired that we can't recover from in-place,
    // a segment 404 storm consumed every retry, etc.). Trigger a
    // full remount by bumping remountNonce — same effect as the
    // operator pressing R on that one tile, but automatic.
    //
    // Cheap: 3-s poll, sub-millisecond compare. Fires AT MOST once
    // per stall event (not a retry loop) because the remount replaces
    // this whole effect + timer with a fresh one.
    let lastSeenTime = -1;
    let lastAdvanceAt = Date.now();
    const stallCheck = window.setInterval(() => {
      const t = video.currentTime;
      const now = Date.now();
      if (t !== lastSeenTime) { lastSeenTime = t; lastAdvanceAt = now; return; }
      if (video.paused) { lastAdvanceAt = now; return; } // paused = expected
      if (now - lastAdvanceAt > 20_000) {
        window.clearInterval(stallCheck);
        setRemountNonce((n) => n + 1);
      }
    }, 3_000);

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      setStatus('error');
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        hls.startLoad();
        setStatus('loading');
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        hls.recoverMediaError();
        setStatus('loading');
      } else {
        // Everything else fatal (buffer-stalled, other-error, key-system,
        // etc.) — no in-place recover exists. Full remount.
        setRemountNonce((n) => n + 1);
      }
    });

    return () => {
      window.clearInterval(stallCheck);
      hls.destroy();
      hlsRef.current = null;
    };
  }, [slug, remountNonce]);

  // Sync audio state with the media element. `audioActive` from the
  // parent is the single source of truth — muted whenever another
  // tile has audio, unmuted when this tile is the chosen one.
  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = !audioActive;
  }, [audioActive]);

  return (
    <div
      onClick={slug ? handleTileClick : undefined}
      onDoubleClick={slug && onDoubleClick ? handleTileDoubleClick : undefined}
      className={cn(
        'relative bg-black overflow-hidden group',
        // Audio-active tile still elevates in z so the border-overlay
        // (rendered below as its own absolute div) reads clearly above
        // adjacent tiles when they touch. Actual border/glow is drawn
        // by the overlay div — putting it as ring-inset on this parent
        // would sit BEHIND the video (video is w-full h-full on top),
        // so operators lost the highlight the moment a channel started
        // playing.
        audioActive && 'z-10',
        slug && 'cursor-pointer',
        className,
      )}
    >
      {slug ? (
        <>
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            // object-fill: simple stretch to fill the tile. Whatever
            // aspect the source arrives in, the video paints edge to
            // edge. Reverted from cover/contain experiments — the
            // stretch trade-off is the user's accepted final choice.
            style={{ objectFit: 'fill' }}
            className="w-full h-full"
          />
          {/* Audio-active border: rendered ABOVE the video so it stays
              visible regardless of object-fit / video paint. Thick light
              green with an outer glow — hard to miss on a busy wall. */}
          {audioActive ? (
            <div
              className="pointer-events-none absolute inset-0 border-4 border-[#4ade80] z-20"
              style={{ boxShadow: '0 0 18px 2px rgba(74,222,128,0.7)' }}
            />
          ) : null}
          {/* corner overlay: logo + name */}
          <div className="absolute top-1 left-1 flex items-center gap-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 backdrop-blur-sm">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt="" className="h-3 w-3 object-contain" />
            ) : null}
            <span className="truncate max-w-[10rem]">{channelName ?? slug}</span>
          </div>
          {/* status pill */}
          {status !== 'playing' ? (
            <div className="absolute top-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-white/70">
              {status}
            </div>
          ) : null}
          {/* hover controls */}
          <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition bg-gradient-to-t from-black/50 via-transparent to-black/40 pointer-events-none">
            <div className="pointer-events-auto absolute bottom-1 right-1 flex gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); onToggleAudio(); }}
                onDoubleClick={(e) => e.stopPropagation()}
                className={cn(
                  'p-1 rounded text-white',
                  audioActive
                    ? 'bg-[#4ade80] text-black hover:bg-[#22c55e]'
                    : 'bg-black/70 hover:bg-black/90',
                )}
                title={audioActive ? 'Mute (currently the audio channel)' : 'Play audio (mutes any other)'}
              >
                {audioActive ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
              </button>
              {onClear ? (
                <button
                  onClick={(e) => { e.stopPropagation(); onClear(); }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  className="p-1 rounded bg-black/70 text-white hover:bg-red-600"
                  title="Remove channel from slot"
                >
                  <X className="h-3 w-3" />
                </button>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <button
          onClick={onPick}
          className="w-full h-full flex items-center justify-center border-2 border-dashed border-white/10 hover:border-white/30 text-white/40 hover:text-white/70 text-xs uppercase tracking-widest transition"
        >
          + Add
        </button>
      )}
    </div>
  );
}
