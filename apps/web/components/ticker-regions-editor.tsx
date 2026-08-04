'use client';

/**
 * Multi-region editor for a channel. Wraps TickerCropEditor with a tabbed
 * shell that lets the operator define up to four zones per channel:
 *   - Ticker (primary)   — the main bottom scroller
 *   - Ticker (secondary) — a second bottom scroller if the channel has one
 *   - Flasher — left    — mid-screen box on the left
 *   - Flasher — right   — mid-screen box on the right
 *
 * Instead of live HLS the editor works off a still frame pulled from
 * /api/channels/:id/frame.png so the operator can precisely crop on a
 * frozen image and doesn't chase moving pixels.
 */
/* eslint-disable react-hooks/rules-of-hooks */
import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Save, Trash2, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export interface Rect { x: number; y: number; w: number; h: number }
type RegionKey = 'tickerPrimaryRect' | 'tickerSecondaryRect' | 'flasherLeftRect' | 'flasherRightRect';

interface Props {
  channelId: string;
  initial: Partial<Record<RegionKey, Rect | null>>;
  onSave: (patch: Partial<Record<RegionKey, Rect | null>>) => Promise<void> | void;
}

const REGIONS: Array<{ key: RegionKey; label: string; snap: Rect }> = [
  { key: 'tickerPrimaryRect',   label: 'Ticker · Primary',   snap: { x: 0.0, y: 0.86, w: 1.0,  h: 0.10 } },
  { key: 'tickerSecondaryRect', label: 'Ticker · Secondary', snap: { x: 0.0, y: 0.76, w: 1.0,  h: 0.08 } },
  { key: 'flasherLeftRect',     label: 'Flasher · Left',     snap: { x: 0.02, y: 0.28, w: 0.24, h: 0.36 } },
  { key: 'flasherRightRect',    label: 'Flasher · Right',    snap: { x: 0.74, y: 0.28, w: 0.24, h: 0.36 } },
];

const HANDLES = [
  { id: 'nw', style: '-top-1 -left-1  cursor-nw-resize' },
  { id: 'n',  style: '-top-1 left-1/2 -translate-x-1/2 cursor-n-resize' },
  { id: 'ne', style: '-top-1 -right-1 cursor-ne-resize' },
  { id: 'e',  style: 'top-1/2 -right-1 -translate-y-1/2 cursor-e-resize' },
  { id: 'se', style: '-bottom-1 -right-1 cursor-se-resize' },
  { id: 's',  style: '-bottom-1 left-1/2 -translate-x-1/2 cursor-s-resize' },
  { id: 'sw', style: '-bottom-1 -left-1  cursor-sw-resize' },
  { id: 'w',  style: 'top-1/2 -left-1 -translate-y-1/2 cursor-w-resize' },
] as const;
type HandleId = typeof HANDLES[number]['id'];

function clamp01(v: number) { return Math.max(0, Math.min(1, v)); }
function pct(v: number) { return `${(v * 100).toFixed(2)}%`; }

export function TickerRegionsEditor({ channelId, initial, onSave }: Props) {
  const [active, setActive] = useState<RegionKey>('tickerPrimaryRect');
  const [rects, setRects] = useState<Partial<Record<RegionKey, Rect | null>>>(initial);
  const [saving, setSaving] = useState(false);
  // Track whether the user has locally edited so a background query refetch
  // (parent re-fetches the channel every 5s) doesn't wipe an in-progress
  // drawing. Once the user saves, we accept the parent's new `initial`.
  const [dirty, setDirty] = useState(false);
  const [frameNonce, setFrameNonce] = useState(() => Date.now());
  const [frameStatus, setFrameStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Fetch the freeze frame WITH the Bearer token (a plain <img src>
  // can't send Authorization headers), then hand the blob to the img tag.
  useEffect(() => {
    let revokeMe: string | null = null;
    let cancelled = false;
    (async () => {
      setFrameStatus('loading');
      try {
        const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
        const r = await fetch(`${API_BASE}/api/channels/${channelId}/frame.png?t=${frameNonce}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        revokeMe = url;
        setFrameSrc(url);
        setFrameStatus('ready');
      } catch {
        if (!cancelled) setFrameStatus('error');
      }
    })();
    return () => { cancelled = true; if (revokeMe) URL.revokeObjectURL(revokeMe); };
  }, [channelId, frameNonce]);
  const [drag, setDrag] = useState<null | { mode: 'draw' | 'move' | HandleId; startX: number; startY: number; origin: Rect }>(null);

  const rect = rects[active] ?? null;

  // Sync from parent only when (a) the channel changes or (b) the user
  // hasn't started editing yet. Otherwise background refetches would blow
  // away in-progress work.
  useEffect(() => {
    if (!dirty) setRects(initial);
  }, [channelId, initial, dirty]);

  function toFrac(e: React.PointerEvent | PointerEvent): { fx: number; fy: number } {
    const el = wrapRef.current!;
    const r = el.getBoundingClientRect();
    return { fx: clamp01((e.clientX - r.left) / r.width), fy: clamp01((e.clientY - r.top) / r.height) };
  }

  function setRect(next: Rect | null) {
    setDirty(true);
    setRects((prev) => ({ ...prev, [active]: next }));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    const { fx, fy } = toFrac(e);
    const target = (e.target as HTMLElement).dataset.handle as HandleId | undefined;
    if (target && rect) { setDrag({ mode: target, startX: fx, startY: fy, origin: { ...rect } }); return; }
    if ((e.target as HTMLElement).dataset.role === 'rect' && rect) {
      setDrag({ mode: 'move', startX: fx, startY: fy, origin: { ...rect } });
      return;
    }
    setRect({ x: fx, y: fy, w: 0, h: 0 });
    setDrag({ mode: 'draw', startX: fx, startY: fy, origin: { x: fx, y: fy, w: 0, h: 0 } });
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!drag) return;
    const { fx, fy } = toFrac(e);
    const dx = fx - drag.startX, dy = fy - drag.startY;
    setRect((() => {
      const o = drag.origin;
      if (drag.mode === 'draw') {
        const x = Math.min(drag.startX, fx), y = Math.min(drag.startY, fy);
        const w = Math.abs(fx - drag.startX), h = Math.abs(fy - drag.startY);
        return { x, y, w, h };
      }
      if (drag.mode === 'move') {
        return { ...o, x: clamp01(o.x + dx), y: clamp01(o.y + dy) };
      }
      let { x, y, w, h } = o;
      if (drag.mode.includes('n')) { const ny = clamp01(o.y + dy); h = clamp01(o.y + o.h - ny); y = ny; }
      if (drag.mode.includes('s')) { h = clamp01(o.h + dy); }
      if (drag.mode.includes('w')) { const nx = clamp01(o.x + dx); w = clamp01(o.x + o.w - nx); x = nx; }
      if (drag.mode.includes('e')) { w = clamp01(o.w + dx); }
      return { x, y, w: Math.max(0.005, w), h: Math.max(0.005, h) };
    })());
  }

  function onPointerUp() {
    setDrag(null);
    if (rect && (rect.w < 0.01 || rect.h < 0.01)) setRect(null);
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(rects);
      // After a successful save we're no longer "dirty" — subsequent
      // parent refetches may safely re-hydrate our state (they should
      // now carry back the values we just persisted).
      setDirty(false);
    } finally {
      setSaving(false);
    }
  }

  const region = REGIONS.find((r) => r.key === active)!;

  return (
    <div className="space-y-3">
      <Tabs value={active} onValueChange={(v) => setActive(v as RegionKey)}>
        <TabsList className="w-full">
          {REGIONS.map((r) => (
            <TabsTrigger key={r.key} value={r.key} className="flex-1">{r.label}</TabsTrigger>
          ))}
        </TabsList>
        {REGIONS.map((r) => <TabsContent key={r.key} value={r.key} className="mt-3" />)}
      </Tabs>

      <div
        ref={wrapRef}
        className="relative w-full aspect-video rounded-lg overflow-hidden border border-line bg-black shadow-soft select-none touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {frameSrc && (
          <img
            key={frameNonce}
            src={frameSrc}
            alt="freeze frame"
            className="absolute inset-0 w-full h-full object-contain bg-black"
          />
        )}
        {frameStatus === 'loading' && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <Loader2 className="h-8 w-8 animate-spin text-brand" />
          </div>
        )}
        {frameStatus === 'error' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center text-white/70 text-xs px-6">
            <div className="text-[13px] font-medium">No live signal yet</div>
            <div className="text-[11px] text-white/50 max-w-md leading-relaxed">
              A freeze frame appears here once this channel starts publishing. Draw regions on a placeholder using the "Snap default" button — they'll take effect the moment frames arrive.
            </div>
            <Button variant="secondary" size="sm" className="mt-1" onClick={() => { setFrameStatus('loading'); setFrameNonce(Date.now()); }}>
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        )}
        {rect && (
          <>
            <div className="pointer-events-none absolute inset-0 bg-black/35" />
            <div
              className="pointer-events-none absolute ring-1 ring-inset ring-white/25"
              style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h), boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
            />
            <div
              data-role="rect"
              className={cn('absolute cursor-move ring-2 ring-brand')}
              style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
            >
              {HANDLES.map((h) => (
                <div key={h.id} data-handle={h.id} className={cn('absolute h-2.5 w-2.5 rounded-sm bg-brand shadow', h.style)} />
              ))}
              <div className="absolute -top-6 left-0 text-[10px] font-mono bg-brand text-white px-1.5 py-0.5 rounded shadow">
                {region.label}
              </div>
            </div>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={() => { setFrameStatus('loading'); setFrameNonce(Date.now()); }}>
            <RefreshCw className="h-3.5 w-3.5" /> New freeze frame
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setRect(region.snap)}>
            <Wand2 className="h-3.5 w-3.5" /> Snap default
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRect(null)} disabled={!rect}>
            <Trash2 className="h-3.5 w-3.5" /> Clear this region
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {rect ? <Badge variant="outline" className="font-mono text-[10px]">x:{pct(rect.x)} y:{pct(rect.y)} w:{pct(rect.w)} h:{pct(rect.h)}</Badge>
                : <span className="text-xs text-muted">Draw a rectangle over the {region.label.toLowerCase()}.</span>}
          <Button variant="gradient" size="sm" onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Save all regions
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2">
        {REGIONS.map((r) => {
          const rr = rects[r.key];
          const filled = !!rr && rr.w > 0 && rr.h > 0;
          return (
            <div key={r.key} className={cn('rounded-md border px-2 py-1.5 text-[11px]',
              filled ? 'border-accent-green/40 bg-accent-green/5' : 'border-line bg-white')}>
              <div className="flex items-center justify-between gap-2">
                <span className="uppercase tracking-widest text-[10px] text-muted-2">{r.label.split(' · ')[1]}</span>
                {filled ? <Badge variant="green">SET</Badge> : <Badge variant="outline">EMPTY</Badge>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
