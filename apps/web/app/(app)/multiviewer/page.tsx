'use client';

/**
 * Video-wall multiviewer.
 *
 * Matches the standalone CMC video-wall app conceptually:
 *   - 4 layouts (single, dual, mosaic-20, grid-32)
 *   - assign a channel per slot from a searchable channel list
 *   - save / load / delete named templates (localStorage; per-browser)
 *   - fullscreen mode
 *   - tiles play live HLS from /hls/<slug>/live.m3u8 (served by API)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Maximize2, Minimize2, Save, Trash2, ChevronDown, Search, X,
  Volume2, VolumeX,
} from 'lucide-react';
import { api } from '@/lib/api';
import { HlsTile } from '@/components/hls-tile';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

/* ------------------------------------------------------------------ */
/* Layouts                                                            */
/* ------------------------------------------------------------------ */

interface Slot {
  x: number;      // 0..1 fraction of wall width
  y: number;      // 0..1 fraction of wall height
  w: number;      // 0..1 fraction
  h: number;      // 0..1 fraction
}

interface Layout {
  id: 'single' | 'dual' | 'grid4' | 'grid8' | 'mosaic' | 'grid32';
  label: string;
  slots: Slot[];
}

const COL_W = 0.25;   // wall = 4 physical columns
const ROW_H = 0.5;    // wall = 2 physical rows

function buildLayouts(): Layout[] {
  const single: Slot[] = [{ x: 0, y: 0, w: 1, h: 1 }];

  const dual: Slot[] = [
    { x: 0.0, y: 0, w: 0.5, h: 1 },
    { x: 0.5, y: 0, w: 0.5, h: 1 },
  ];

  // Mosaic-20: 4 big tiles across the top row + 16 quadrants below.
  const mosaic: Slot[] = [];
  for (let c = 0; c < 4; c++) {
    mosaic.push({ x: c * COL_W, y: 0, w: COL_W, h: ROW_H });
  }
  for (let c = 0; c < 4; c++) {
    for (let qy = 0; qy < 2; qy++) {
      for (let qx = 0; qx < 2; qx++) {
        mosaic.push({
          x: c * COL_W + qx * (COL_W / 2),
          y: ROW_H + qy * (ROW_H / 2),
          w: COL_W / 2,
          h: ROW_H / 2,
        });
      }
    }
  }

  // Grid4: 2 cols × 2 rows = 4 slots — big tiles for a small
  // priority set (e.g. focus mode on 4 channels).
  const grid4: Slot[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 2; c++) {
      grid4.push({ x: c / 2, y: r / 2, w: 1 / 2, h: 1 / 2 });
    }
  }

  // Grid8: 4 cols × 2 rows = 8 slots. Fills the wall with fewer,
  // larger tiles than grid32 — better for shifts that follow a
  // priority set of ~8 channels without needing full-wall detail.
  const grid8: Slot[] = [];
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 4; c++) {
      grid8.push({ x: c / 4, y: r / 2, w: 1 / 4, h: 1 / 2 });
    }
  }

  // Grid32: 8 cols × 4 rows = 32 slots — user's original request,
  // matches the standalone Rust wall.
  const grid32: Slot[] = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 8; c++) {
      grid32.push({ x: c / 8, y: r / 4, w: 1 / 8, h: 1 / 4 });
    }
  }

  return [
    { id: 'single', label: '1 · Single',       slots: single },
    { id: 'dual',   label: '2 · Dual',         slots: dual },
    { id: 'grid4',  label: '3 · Grid (4)',     slots: grid4 },
    { id: 'grid8',  label: '4 · Grid (8)',     slots: grid8 },
    { id: 'mosaic', label: '5 · Mosaic (20)',  slots: mosaic },
    { id: 'grid32', label: '6 · Grid (32)',    slots: grid32 },
  ];
}

const LAYOUTS = buildLayouts();

/* ------------------------------------------------------------------ */
/* Templates (localStorage)                                           */
/* ------------------------------------------------------------------ */

interface Template {
  name: string;
  layoutId: Layout['id'];
  /** Slot index (as string) → channel slug */
  slots: Record<string, string>;
}

const TEMPLATES_KEY = 'cmc-multiviewer-templates:v1';

function loadTemplates(): Template[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(TEMPLATES_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr as Template[];
  } catch { /* ignore corrupt localStorage */ }
  return [];
}

function saveTemplates(list: Template[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

interface Channel {
  id: string;
  slug: string;
  name: string;
  logoUrl?: string | null;
  active?: boolean;
}

export default function MultiviewerPage() {
  const [layoutId, setLayoutId] = useState<Layout['id']>('mosaic');
  const [assignments, setAssignments] = useState<Record<string, string>>({});
  const [templates, setTemplates] = useState<Template[]>([]);
  const [pickerSlotIdx, setPickerSlotIdx] = useState<number | null>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Bumped by pressing 'R' anywhere on the wall (fullscreen or not).
  // Fed into each HlsTile's React key so a bump forces a full unmount+
  // remount → the hls.js instance inside is destroyed and rebuilt from
  // scratch, so any tile that latched into a permanent-failure state
  // (post-recycle 404, socket refused, source hiccup) comes back live.
  const [refreshTick, setRefreshTick] = useState(0);
  /** Slot index whose audio is currently ON, or null if all muted.
   * Enforces "only one channel makes noise at a time" — clicking a
   * different tile's volume icon switches audio to that tile and
   * mutes the previous. */
  const [audioSlotIdx, setAudioSlotIdx] = useState<number | null>(null);
  /** Snapshot of layout+assignments taken when the operator double-clicks
   * a tile to solo it. `null` = not in solo mode. Esc restores from this. */
  const [soloRestore, setSoloRestore] = useState<
    { layoutId: Layout['id']; assignments: Record<string, string>; audioSlotIdx: number | null } | null
  >(null);
  const wallRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(
    () => LAYOUTS.find((l) => l.id === layoutId) ?? LAYOUTS[2]!,
    [layoutId],
  );

  const { data: channels } = useQuery<Channel[]>({
    queryKey: ['channels', 'multiviewer'],
    queryFn: async () => api<Channel[]>('/api/channels'),
  });
  const channelBySlug = useMemo(() => {
    const m = new Map<string, Channel>();
    (channels ?? []).forEach((c) => m.set(c.slug, c));
    return m;
  }, [channels]);

  // Load templates once on mount.
  useEffect(() => { setTemplates(loadTemplates()); }, []);

  // Track browser fullscreen state (Esc / F11 exit needs a listener).
  useEffect(() => {
    const on = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const assignSlot = useCallback((idx: number, slug: string | null) => {
    setAssignments((prev) => {
      const next = { ...prev };
      if (slug) next[String(idx)] = slug;
      else delete next[String(idx)];
      return next;
    });
    // If we just cleared the slot that had audio on, kill audio too.
    if (!slug) setAudioSlotIdx((cur) => (cur === idx ? null : cur));
  }, []);

  const toggleAudio = useCallback((idx: number) => {
    setAudioSlotIdx((cur) => (cur === idx ? null : idx));
  }, []);

  const applyTemplate = useCallback((t: Template) => {
    setLayoutId(t.layoutId);
    setAssignments({ ...t.slots });
  }, []);

  const handleSaveTemplate = useCallback(() => {
    const name = templateName.trim();
    if (!name) return;
    const t: Template = { name, layoutId, slots: { ...assignments } };
    const next = [...templates.filter((x) => x.name !== name), t]
      .sort((a, b) => a.name.localeCompare(b.name));
    setTemplates(next);
    saveTemplates(next);
    setTemplateName('');
    setSaveDialogOpen(false);
  }, [templateName, layoutId, assignments, templates]);

  const handleDeleteTemplate = useCallback((name: string) => {
    const next = templates.filter((x) => x.name !== name);
    setTemplates(next);
    saveTemplates(next);
  }, [templates]);

  const toggleFullscreen = useCallback(() => {
    const el = wallRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen().catch(() => {});
    else document.exitFullscreen().catch(() => {});
  }, []);

  /** Double-click a tile → solo that channel using the single-layout.
   *  Saves current layout+assignments+audio so Esc can restore. */
  const enterSolo = useCallback((slug: string) => {
    setSoloRestore((prev) => prev ?? {
      layoutId,
      assignments: { ...assignments },
      audioSlotIdx,
    });
    setLayoutId('single');
    setAssignments({ '0': slug });
    // Solo audio ON by default — operator dove into this channel to
    // listen to it. If they had another channel's audio on, that's
    // preserved in the restore snapshot.
    setAudioSlotIdx(0);
  }, [layoutId, assignments, audioSlotIdx]);

  /** Restore the pre-solo layout snapshot. */
  const exitSolo = useCallback(() => {
    setSoloRestore((snap) => {
      if (!snap) return null;
      setLayoutId(snap.layoutId);
      setAssignments(snap.assignments);
      setAudioSlotIdx(snap.audioSlotIdx);
      return null;
    });
  }, []);

  /** Always-on: `r` (or `R`) refreshes every tile — unmount+remount
   *  every HlsTile so hls.js drops any latched failure and reconnects
   *  fresh. Works in fullscreen too. Ignores modifier combos so
   *  browser shortcuts like Ctrl-R for a full page reload still fire. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setRefreshTick((t) => t + 1);
        toast.success('Wall refreshed');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** Esc while soloing → exit solo. `s` in solo OR single-layout →
   *  POST /api/channels/:id/snapshot to grab a still frame. */
  useEffect(() => {
    const inSolo = !!soloRestore;
    const inSingle = layout.id === 'single';
    if (!inSolo && !inSingle) return;
    const onKey = (e: KeyboardEvent) => {
      // Ignore key events from form fields
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === 'Escape' && inSolo) { exitSolo(); return; }
      if (e.key === 's' || e.key === 'S') {
        const slug = assignments['0'];
        if (!slug) return;
        const c = channelBySlug.get(slug);
        if (!c) return;
        // Fire and forget — the recording server captures locally, no
        // wait needed. Toast shows completion / failure.
        (async () => {
          try {
            // Empty {} body forces the api() helper to send a
            // Content-Type header. Fastify rejects body-less POSTs
            // with 415 by default; the empty object satisfies that.
            await api(`/api/channels/${c.id}/snapshot`, { method: 'POST', body: {} });
            toast.success(`Frame saved: ${c.name}`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Snapshot failed');
          }
        })();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [soloRestore, exitSolo, layout.id, assignments, channelBySlug]);

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-line bg-white/60">
        {soloRestore ? (
          <button
            onClick={exitSolo}
            className="px-3 py-1 text-xs rounded-md ring-1 ring-primary bg-primary text-white hover:opacity-90 transition"
            title="Restore your previous layout (Esc)"
          >
            ← Back to layout (Esc)
          </button>
        ) : (
          <>
            <div className="text-sm text-muted">Layout:</div>
            <div className="flex gap-1">
              {LAYOUTS.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setLayoutId(l.id)}
                  className={cn(
                    'px-2.5 py-1 text-xs rounded-md ring-1 transition',
                    layoutId === l.id
                      ? 'bg-primary text-white ring-primary'
                      : 'bg-panel2 text-txt ring-line hover:bg-panel2/80',
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="mx-2 h-5 border-l border-line" />

        <TemplateDropdown
          templates={templates}
          onApply={applyTemplate}
          onDelete={handleDeleteTemplate}
        />

        <Button
          variant="secondary"
          size="sm"
          onClick={() => setSaveDialogOpen(true)}
          className="h-7"
        >
          <Save className="h-3.5 w-3.5 mr-1" /> Save as template
        </Button>

        <div className="ml-auto flex items-center gap-2">
          {audioSlotIdx !== null ? (
            <div
              className="flex items-center gap-1.5 rounded-md bg-accent-orange/10 text-accent-orange ring-1 ring-accent-orange/40 px-2 py-1 text-xs font-medium"
              title="Currently playing audio — click the tile's speaker icon (or the X here) to mute"
            >
              <Volume2 className="h-3.5 w-3.5" />
              <span className="max-w-[10rem] truncate">
                {channelBySlug.get(assignments[String(audioSlotIdx)] ?? '')?.name
                  ?? assignments[String(audioSlotIdx)]
                  ?? 'Audio'}
              </span>
              <button
                onClick={() => setAudioSlotIdx(null)}
                className="ml-1 rounded p-0.5 hover:bg-accent-orange/20"
                title="Mute all"
              >
                <VolumeX className="h-3 w-3" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-xs text-muted" title="Click a tile's speaker icon to enable audio">
              <VolumeX className="h-3.5 w-3.5" /> Audio muted
            </div>
          )}

          <div className="text-xs text-muted">
            {Object.keys(assignments).length}/{layout.slots.length} slots filled
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={toggleFullscreen}
            className="h-7"
          >
            {isFullscreen
              ? <><Minimize2 className="h-3.5 w-3.5 mr-1" /> Exit fullscreen</>
              : <><Maximize2 className="h-3.5 w-3.5 mr-1" /> Fullscreen</>}
          </Button>
        </div>
      </div>

      {/* Wall */}
      <div className="flex-1 bg-black overflow-hidden" ref={wallRef}>
        <div className="relative w-full h-full">
          {layout.slots.map((slot, idx) => {
            const slug = assignments[String(idx)] ?? null;
            const ch = slug ? channelBySlug.get(slug) : undefined;
            return (
              <div
                key={idx}
                style={{
                  position: 'absolute',
                  left: `${slot.x * 100}%`,
                  top: `${slot.y * 100}%`,
                  width: `${slot.w * 100}%`,
                  height: `${slot.h * 100}%`,
                }}
              >
                <HlsTile
                  key={`${slug ?? 'empty'}-${refreshTick}`}
                  slug={slug}
                  channelName={ch?.name}
                  logoUrl={ch?.logoUrl ?? undefined}
                  audioActive={audioSlotIdx === idx}
                  onToggleAudio={() => toggleAudio(idx)}
                  onClear={() => assignSlot(idx, null)}
                  onPick={() => setPickerSlotIdx(idx)}
                  onDoubleClick={slug ? () => enterSolo(slug) : undefined}
                  className="w-full h-full"
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Save-template dialog */}
      <Dialog open={saveDialogOpen} onOpenChange={setSaveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save as template</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Template name (e.g. Prime-time news)"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveTemplate(); }}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setSaveDialogOpen(false)}>Cancel</Button>
              <Button variant="gradient" onClick={handleSaveTemplate} disabled={!templateName.trim()}>
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Channel picker */}
      <ChannelPicker
        open={pickerSlotIdx !== null}
        onOpenChange={(open) => { if (!open) setPickerSlotIdx(null); }}
        channels={channels ?? []}
        currentAssignments={assignments}
        onPick={(slug) => {
          if (pickerSlotIdx !== null) {
            assignSlot(pickerSlotIdx, slug);
            setPickerSlotIdx(null);
          }
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Template dropdown                                                  */
/* ------------------------------------------------------------------ */

function TemplateDropdown({
  templates, onApply, onDelete,
}: {
  templates: Template[];
  onApply: (t: Template) => void;
  onDelete: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        className="h-7"
        disabled={templates.length === 0}
      >
        Templates <ChevronDown className="h-3.5 w-3.5 ml-1" />
      </Button>
      {open ? (
        <div
          className="absolute z-20 mt-1 min-w-[240px] rounded-md border border-line bg-white shadow-lg"
          onMouseLeave={() => setOpen(false)}
        >
          {templates.map((t) => (
            <div key={t.name} className="flex items-center justify-between px-3 py-1.5 hover:bg-panel2 group">
              <button
                onClick={() => { onApply(t); setOpen(false); }}
                className="flex-1 text-left text-sm"
              >
                <div className="font-medium truncate">{t.name}</div>
                <div className="text-[10px] text-muted uppercase tracking-wider">
                  {t.layoutId} · {Object.keys(t.slots).length} channels
                </div>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(t.name); }}
                className="p-1 text-muted hover:text-accent-red opacity-0 group-hover:opacity-100"
                title="Delete template"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Channel picker with search + highlight                             */
/* ------------------------------------------------------------------ */

function ChannelPicker({
  open, onOpenChange, channels, currentAssignments, onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: Channel[];
  currentAssignments: Record<string, string>;
  onPick: (slug: string) => void;
}) {
  const [q, setQ] = useState('');

  const selectedSlugs = useMemo(
    () => new Set(Object.values(currentAssignments)),
    [currentAssignments],
  );

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const src = [...channels].sort((a, b) => a.name.localeCompare(b.name));
    if (!term) return src;
    return src.filter(
      (c) =>
        c.name.toLowerCase().includes(term)
        || c.slug.toLowerCase().includes(term),
    );
  }, [channels, q]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Pick a channel</DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted" />
          <Input
            autoFocus
            placeholder="Search by name or slug..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-8"
          />
          {q ? (
            <button
              onClick={() => setQ('')}
              className="absolute right-2 top-2 text-muted hover:text-txt"
              title="Clear"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        <ScrollArea className="h-[420px] pr-2 mt-2">
          <ul className="space-y-0.5">
            {filtered.map((c) => {
              const inUse = selectedSlugs.has(c.slug);
              return (
                <li key={c.id}>
                  <button
                    onClick={() => onPick(c.slug)}
                    className={cn(
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-left transition',
                      inUse
                        ? 'bg-primary/10 text-primary ring-1 ring-primary/30'
                        : 'hover:bg-panel2',
                    )}
                  >
                    {c.logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.logoUrl} alt="" className="h-4 w-4 object-contain" />
                    ) : <div className="h-4 w-4 rounded bg-panel2" />}
                    <span className="flex-1 truncate">{c.name}</span>
                    {inUse ? (
                      <span className="text-[10px] uppercase tracking-wider text-primary">in use</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
            {filtered.length === 0 ? (
              <li className="text-sm text-muted px-2 py-2">No matches.</li>
            ) : null}
          </ul>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
