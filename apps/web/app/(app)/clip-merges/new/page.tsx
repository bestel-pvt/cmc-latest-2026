'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowUp, ArrowDown, Trash2, Loader2, Layers, Download } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import {
  readQueue, moveInQueue, removeFromQueue, clearQueue,
  type MergeQueueItem, MAX_QUEUE,
} from '@/lib/merge-queue';

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m.toString().padStart(2, '0')}m ${sec.toString().padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${sec.toString().padStart(2, '0')}s`;
  return `${sec}s`;
}

export default function NewClipMergePage() {
  const router = useRouter();
  const [items, setItems] = useState<MergeQueueItem[]>([]);
  const [title, setTitle] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [resolution, setResolution] = useState<string>('1280x720');

  useEffect(() => { setItems(readQueue()); }, []);

  const totalMs = useMemo(() => items.reduce(
    (acc, x) => acc + Math.max(0, new Date(x.endAt).getTime() - new Date(x.startAt).getTime()),
    0,
  ), [items]);

  const canSubmit = title.trim().length > 0 && items.length >= 2;

  const submit = useMutation({
    mutationFn: () => api('/api/clip-merges', {
      method: 'POST',
      body: {
        title: title.trim(),
        notes: notes.trim() || null,
        format: 'MP4',
        resolution,
        segments: items.map((x) => ({ channelId: x.channelId, startAt: x.startAt, endAt: x.endAt })),
      },
    }),
    onSuccess: () => {
      toast.success('Merge queued — render in progress');
      clearQueue();
      router.push('/clip-merges');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Submit failed'),
  });

  return (
    <div className="max-w-[1100px] mx-auto space-y-5">
      <div className="flex items-center gap-3">
        <Link href="/clip-merges" className="text-muted hover:text-txt"><ArrowLeft className="h-4 w-4" /></Link>
        <div className="flex-1">
          <h1 className="font-display text-2xl font-bold tracking-tight">New Merged Clip</h1>
          <p className="text-xs text-muted mt-0.5">
            {items.length} segment{items.length === 1 ? '' : 's'} · total length {fmtDur(totalMs)} · stitched in order
          </p>
        </div>
        <Button
          variant="gradient"
          disabled={!canSubmit || submit.isPending}
          onClick={() => submit.mutate()}
        >
          {submit.isPending ? <Loader2 className="animate-spin h-4 w-4" /> : <Download className="h-4 w-4" />}
          Render merged clip
        </Button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-4">
        <Card className="overflow-hidden">
          <CardHeader>
            <CardTitle>Queue</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {items.length === 0 ? (
              <div className="p-10 text-center text-sm text-muted">
                <Layers className="h-8 w-8 mx-auto mb-3 text-muted-2" />
                Empty queue. Open a recording in the clip editor and press
                <span className="font-semibold"> &ldquo;Add to merge queue&rdquo;</span> for each segment you want to stitch (min 2, max {MAX_QUEUE}).
                <div className="mt-4"><Link href="/clips/new" className="text-brand underline text-xs">Go to clip editor</Link></div>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
                  <tr>
                    <th className="text-left px-4 py-2 w-10">#</th>
                    <th className="text-left px-4 py-2">Channel · Window</th>
                    <th className="text-left px-4 py-2 w-24">Length</th>
                    <th className="px-4 py-2 w-28"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {items.map((x, idx) => {
                    const durMs = Math.max(0, new Date(x.endAt).getTime() - new Date(x.startAt).getTime());
                    return (
                      <tr key={x.cid} className="hover:bg-panel/40">
                        <td className="px-4 py-3 font-mono text-xs text-muted-2">{idx + 1}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            <Badge variant="outline" className="mr-2">{x.channelName}</Badge>
                            <span className="font-mono text-xs text-muted">
                              {new Date(x.startAt).toLocaleString()} → {new Date(x.endAt).toLocaleTimeString()}
                            </span>
                          </div>
                          {x.labelHint && (
                            <div className="text-[11px] text-muted-2 mt-0.5 truncate">{x.labelHint}</div>
                          )}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs">{fmtDur(durMs)}</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              variant="ghost" size="sm" title="Move up"
                              disabled={idx === 0}
                              onClick={() => setItems(moveInQueue(x.cid, 'up'))}
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="sm" title="Move down"
                              disabled={idx === items.length - 1}
                              onClick={() => setItems(moveInQueue(x.cid, 'down'))}
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              variant="ghost" size="sm" title="Remove"
                              onClick={() => setItems(removeFromQueue(x.cid))}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Output</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <label className="block">
              <span className="text-muted-2 uppercase tracking-widest text-[10px]">Title *</span>
              <input
                type="text" value={title} onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Multi-channel highlight 2026-10-20"
                className="mt-1 w-full h-9 px-3 rounded-md border border-line bg-white"
                maxLength={200}
              />
            </label>
            <label className="block">
              <span className="text-muted-2 uppercase tracking-widest text-[10px]">Notes</span>
              <textarea
                value={notes} onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="mt-1 w-full px-3 py-2 rounded-md border border-line bg-white resize-y"
                maxLength={1000}
              />
            </label>
            <label className="block">
              <span className="text-muted-2 uppercase tracking-widest text-[10px]">Resolution</span>
              <select
                value={resolution} onChange={(e) => setResolution(e.target.value)}
                className="mt-1 w-full h-9 px-2 rounded-md border border-line bg-white"
              >
                <option value="640x360">360p</option>
                <option value="854x480">480p</option>
                <option value="1280x720">720p (recommended)</option>
                <option value="1920x1080">1080p</option>
              </select>
            </label>
            <div className="pt-3 border-t border-line text-[11px] text-muted-2">
              Format: MP4 (H.264 + AAC). Each segment renders at the chosen
              resolution; final stitch is stream-copy, so merge finishes in
              seconds regardless of total length.
            </div>
            {items.length > 0 && (
              <Button
                variant="ghost" size="sm" className="w-full mt-2"
                onClick={() => {
                  if (window.confirm('Clear the whole merge queue?')) {
                    clearQueue();
                    setItems([]);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" /> Clear queue
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
