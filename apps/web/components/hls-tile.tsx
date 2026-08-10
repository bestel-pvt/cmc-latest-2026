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

    // Recovery state: hls.js's recoverMediaError() sometimes patches
    // over the same broken segment forever without ever recovering
    // (specifically CNN's SCTE-35 + teletext streams hit fragParsingError
    // repeatedly). If we take more than N consecutive fatal errors
    // without the video actually resuming, we drop and rebuild the
    // whole hls.js instance — that clears every internal buffer and
    // parser state cleanly.
    let fatalCount = 0;
    let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

    // Retry play() until it actually sticks — Chrome autoplay policy
    // sometimes rejects the first call even on muted video (paused
    // background tab). Without retry, hls.js fetches 1 segment then
    // idles because the video element never demands more.
    let playRetryTimer: ReturnType<typeof setTimeout> | null = null;
    const tryPlay = (attempt = 0): void => {
      video.play().catch(() => {
        if (attempt < 10) {
          playRetryTimer = setTimeout(() => tryPlay(attempt + 1), 500);
        }
      });
    };

    const build = (): Hls => {
      const inst = new Hls({
        // User accepts high latency in exchange for zero stalls.
        // 6 s segments × liveSyncDurationCount 3 = start ~18 s behind live.
        liveDurationInfinity: true,
        lowLatencyMode: false,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 40,
        maxBufferLength: 120,
        maxMaxBufferLength: 240,
        backBufferLength: 60,
        maxLiveSyncPlaybackRate: 1.05,
        fragLoadingMaxRetry: 8,
        fragLoadingRetryDelay: 500,
        levelLoadingMaxRetry: 6,
        manifestLoadingMaxRetry: 6,
        // NOTE: initialLiveManifestSize + startPosition -1 removed —
        // they were too aggressive with the shorter 10-segment playlist
        // and caused tiles to reload continuously as hls.js kept
        // fetching + failing to buffer enough before playback. Default
        // (3 segments buffered before playing) is the right balance.
      });
      inst.attachMedia(video);
      inst.on(Hls.Events.MEDIA_ATTACHED, () => inst.loadSource(url));
      inst.on(Hls.Events.MANIFEST_PARSED, () => {
        tryPlay();
        setStatus('playing');
      });
      inst.on(Hls.Events.FRAG_LOADED, () => {
        // Successful load = reset fatal counter; whatever transient
        // error we saw is behind us.
        fatalCount = 0;
        if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null; }
      });
      inst.on(Hls.Events.ERROR, (_evt, data) => {
        if (!data.fatal) return;
        fatalCount++;
        setStatus('error');
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          inst.startLoad();
          setStatus('loading');
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && fatalCount <= 2) {
          inst.recoverMediaError();
          setStatus('loading');
        } else {
          // 3+ fatal errors without recovery, or a non-media/network
          // fatal — rebuild the whole thing. Delay briefly so we do
          // not thrash if the source is genuinely down.
          if (rebuildTimer) clearTimeout(rebuildTimer);
          rebuildTimer = setTimeout(() => {
            rebuildTimer = null;
            if (hlsRef.current === inst) {
              inst.destroy();
              fatalCount = 0;
              hlsRef.current = build();
            }
          }, 3000);
        }
      });
      return inst;
    };

    hlsRef.current = build();

    return () => {
      if (rebuildTimer) clearTimeout(rebuildTimer);
      if (playRetryTimer) clearTimeout(playRetryTimer);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, [slug]);

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
            // object-fill: back to the operator's original choice —
            // stretch to fill tile. Layout aspect does not visibly
            // affect ticker sharpness on the wall; the ticker
            // sharpness is dominated by the ENCODER preset + scaler,
            // which is fixed on the server side.
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
