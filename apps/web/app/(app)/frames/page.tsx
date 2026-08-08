'use client';

/**
 * Frames — snapshots captured by the operator hitting `s` on a single-
 * layout tile (or the fetch-frame button on the channel detail page).
 * Storage is filesystem only on the server; this page just lists what's
 * on disk, filters it, and offers per-frame + delete-all cleanup.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Search, X, Download, Crop, Save, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';

interface Frame {
  id: string;
  channelId: string;
  capturedAt: string;
  sizeBytes: number;
  imageUrl: string;
}
interface Channel {
  id: string;
  slug: string;
  name: string;
}

export default function FramesPage() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [channelFilter, setChannelFilter] = useState<'all' | string>('all');
  const [preview, setPreview] = useState<Frame | null>(null);

  const { data: channels } = useQuery<Channel[]>({
    queryKey: ['channels', 'frames'],
    queryFn: () => api<Channel[]>('/api/channels'),
  });
  const channelById = useMemo(() => {
    const m = new Map<string, Channel>();
    (channels ?? []).forEach((c) => m.set(c.id, c));
    return m;
  }, [channels]);

  const { data: frames, isLoading } = useQuery<Frame[]>({
    queryKey: ['frames', channelFilter],
    queryFn: () => {
      const p = new URLSearchParams();
      if (channelFilter !== 'all') p.set('channelId', channelFilter);
      return api<Frame[]>(`/api/frames${p.toString() ? `?${p}` : ''}`);
    },
    refetchInterval: 30_000,
  });

  const filtered = useMemo(() => {
    const rows = frames ?? [];
    if (!q.trim()) return rows;
    const term = q.trim().toLowerCase();
    return rows.filter((f) => {
      const ch = channelById.get(f.channelId);
      return (
        f.capturedAt.toLowerCase().includes(term) ||
        f.channelId.toLowerCase().includes(term) ||
        (ch?.name.toLowerCase().includes(term) ?? false) ||
        (ch?.slug.toLowerCase().includes(term) ?? false)
      );
    });
  }, [frames, q, channelById]);

  const deleteOne = useMutation({
    mutationFn: (id: string) => api(`/api/frames/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['frames'] }); toast.success('Frame deleted'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete failed'),
  });

  const deleteAll = useMutation({
    mutationFn: () => api<{ deleted: number }>('/api/frames', { method: 'DELETE' }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['frames'] }); toast.success(`Deleted ${r.deleted} frames`); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Delete-all failed'),
  });

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Frames</h1>
          <p className="text-xs text-muted mt-0.5">
            Still captures. Press <kbd className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] ring-1 ring-line">S</kbd> on a single-layout tile in Video Wall to save a frame.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="text-red-600 hover:text-red-700"
            onClick={() => {
              if (!filtered.length) return;
              if (!confirm(`Delete ALL ${frames?.length ?? 0} frames? This cannot be undone.`)) return;
              deleteAll.mutate();
            }}
            disabled={deleteAll.isPending || (frames?.length ?? 0) === 0}
          >
            <Trash2 className="h-4 w-4" /> Delete all
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by channel or timestamp" className="pl-9" />
          </div>
          <Select value={channelFilter} onValueChange={setChannelFilter}>
            <SelectTrigger className="w-56"><SelectValue placeholder="Channel" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All channels</SelectItem>
              {(channels ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-2 ml-auto">
            {filtered.length} of {frames?.length ?? 0} frames
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
        {isLoading && Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="aspect-video bg-panel2 animate-pulse rounded" />
        ))}
        {!isLoading && filtered.map((f) => {
          const ch = channelById.get(f.channelId);
          return (
            <button
              key={f.id}
              onClick={() => setPreview(f)}
              className={cn(
                'group relative aspect-video bg-black rounded overflow-hidden ring-1 ring-line hover:ring-primary transition',
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={f.imageUrl} alt="" className="w-full h-full object-contain" loading="lazy" />
              <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent p-1.5 text-left">
                <div className="text-[11px] font-medium text-white truncate">{ch?.name ?? f.channelId}</div>
                <div className="text-[9px] text-white/70 truncate">
                  {new Date(f.capturedAt).toLocaleString()}
                </div>
              </div>
            </button>
          );
        })}
        {!isLoading && filtered.length === 0 && (
          <div className="col-span-full p-10 text-center text-sm text-muted">
            No frames yet. Open a channel in Video Wall single layout and press <kbd className="rounded bg-panel2 px-1.5 py-0.5 text-[10px] ring-1 ring-line">S</kbd>.
          </div>
        )}
      </div>

      {preview && (
        <FramePreviewModal
          frame={preview}
          channelName={channelById.get(preview.channelId)?.name ?? preview.channelId}
          onClose={() => setPreview(null)}
          onDelete={() => {
            deleteOne.mutate(preview.id);
            setPreview(null);
          }}
        />
      )}
    </div>
  );
}

function FramePreviewModal({
  frame, channelName, onClose, onDelete,
}: {
  frame: Frame; channelName: string; onClose: () => void; onDelete: () => void;
}) {
  const qc = useQueryClient();
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [cropMode, setCropMode] = useState(false);
  // Rect in NATURAL (source-pixel) coordinates so the server-side crop
  // command gets the exact numbers ffmpeg needs.
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState<{ startX: number; startY: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (cropMode) { setCropMode(false); setRect(null); } else onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cropMode, onClose]);

  const cropMut = useMutation({
    mutationFn: () => {
      if (!rect) throw new Error('no crop selected');
      return api(`/api/frames/${encodeURIComponent(frame.id)}/crop`, {
        method: 'POST',
        body: { x: rect.x, y: rect.y, width: rect.w, height: rect.h },
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['frames'] });
      toast.success(`Crop saved (${rect?.w}×${rect?.h})`);
      setCropMode(false); setRect(null);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Crop failed'),
  });

  /** Convert an event's client X/Y to natural-image pixel coordinates. */
  function toImagePx(e: React.PointerEvent<HTMLDivElement>): { x: number; y: number } | null {
    const img = imgRef.current;
    if (!img) return null;
    const rc = img.getBoundingClientRect();
    if (rc.width === 0 || rc.height === 0) return null;
    // Displayed size might letterbox inside the container; use the img's
    // own client size, then scale to naturalWidth/Height.
    const cx = Math.max(0, Math.min(rc.width,  e.clientX - rc.left));
    const cy = Math.max(0, Math.min(rc.height, e.clientY - rc.top));
    const sx = img.naturalWidth  / rc.width;
    const sy = img.naturalHeight / rc.height;
    return { x: Math.round(cx * sx), y: Math.round(cy * sy) };
  }

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!cropMode) return;
    const p = toImagePx(e); if (!p) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging({ startX: p.x, startY: p.y });
    setRect({ x: p.x, y: p.y, w: 0, h: 0 });
  }
  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragging) return;
    const p = toImagePx(e); if (!p) return;
    const x = Math.min(dragging.startX, p.x);
    const y = Math.min(dragging.startY, p.y);
    const w = Math.abs(p.x - dragging.startX);
    const h = Math.abs(p.y - dragging.startY);
    setRect({ x, y, w, h });
  }
  function onUp() { setDragging(null); }

  /** Overlay rect in DISPLAY coordinates (scaled back from natural). */
  const overlay = (() => {
    if (!rect || !imgRef.current) return null;
    const img = imgRef.current;
    const rc = img.getBoundingClientRect();
    const sx = rc.width  / img.naturalWidth;
    const sy = rc.height / img.naturalHeight;
    return { left: rect.x * sx, top: rect.y * sy, width: rect.w * sx, height: rect.h * sy };
  })();

  return (
    <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={onClose}>
      <div className="relative max-w-6xl max-h-[90vh] w-full bg-black rounded overflow-hidden ring-1 ring-line" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-2 bg-panel2/95 border-b border-line">
          <div className="text-sm">
            <div className="font-semibold">{channelName}</div>
            <div className="text-xs text-muted-2">
              {new Date(frame.capturedAt).toLocaleString()} · {(frame.sizeBytes/1024).toFixed(0)} KB
              {cropMode && rect && rect.w > 0 && rect.h > 0 ? (
                <span className="ml-2 text-accent-cyan">crop: {rect.w}×{rect.h} @ ({rect.x}, {rect.y})</span>
              ) : cropMode ? (
                <span className="ml-2 text-accent-amber">click-drag on the image to select a region</span>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {cropMode ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => setRect(null)} disabled={!rect}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1" /> Reset
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setCropMode(false); setRect(null); }}>
                  Cancel
                </Button>
                <Button
                  variant="gradient"
                  size="sm"
                  disabled={!rect || rect.w < 4 || rect.h < 4 || cropMut.isPending}
                  onClick={() => cropMut.mutate()}
                >
                  <Save className="h-3.5 w-3.5 mr-1" /> Save crop
                </Button>
              </>
            ) : (
              <>
                <Button variant="secondary" size="sm" onClick={() => setCropMode(true)} title="Draw a region to crop">
                  <Crop className="h-3.5 w-3.5 mr-1" /> Crop
                </Button>
                <Button variant="secondary" size="sm" asChild>
                  <a href={frame.imageUrl} download={`${frame.id.replace('/', '_')}`}>
                    <Download className="h-3.5 w-3.5 mr-1" /> Download
                  </a>
                </Button>
                <Button variant="secondary" size="sm" className="text-red-600" onClick={onDelete}>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
                </Button>
                <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
              </>
            )}
          </div>
        </div>
        <div className="bg-black flex items-center justify-center max-h-[calc(90vh-3rem)] overflow-auto relative">
          <div
            className={cn('relative', cropMode && 'cursor-crosshair select-none')}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img ref={imgRef} src={frame.imageUrl} alt="" className="max-w-full max-h-[calc(90vh-3rem)] object-contain block" draggable={false} />
            {cropMode && overlay && (
              <div
                className="absolute border-2 border-accent-cyan bg-accent-cyan/10 pointer-events-none"
                style={{ left: overlay.left, top: overlay.top, width: overlay.width, height: overlay.height }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// Crop / cutout tool (Phase 3.2/3.3) will add a canvas overlay + drag
// rect + POST /api/frames/:id/cutout endpoint. Deliberately not shipped
// this iteration — the base viewer + list + delete flow is what the
// operator needs first.
