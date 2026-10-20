'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Download, Loader2, Layers, Trash2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { fmtBytes } from '@/lib/utils';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface MergeSegment {
  id: string;
  orderIdx: number;
  channelId: string;
  startAt: string;
  endAt: string;
  channel: { id: string; name: string; slug: string };
}

interface ClipMerge {
  id: string;
  title: string;
  notes: string | null;
  format: string;
  resolution: string;
  status: 'QUEUED' | 'RENDERING' | 'READY' | 'FAILED';
  path: string | null;
  sizeBytes: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: { id: string; name: string };
  segments: MergeSegment[];
}

export default function ClipMergesPage() {
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data: merges } = useQuery<ClipMerge[]>({
    queryKey: ['clip-merges'],
    queryFn: () => api<ClipMerge[]>('/api/clip-merges?limit=200'),
    refetchInterval: 5_000,
  });

  async function downloadMerge(m: ClipMerge) {
    if (downloadingId) return;
    setDownloadingId(m.id);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
      const r = await fetch(`${API_BASE}/api/clip-merges/${m.id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        throw new Error(r.status === 401 ? 'Session expired — please sign in again.' : `HTTP ${r.status}${body ? ` — ${body.slice(0, 100)}` : ''}`);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${m.title.replace(/[^a-z0-9-_]+/gi, '_')}.${m.format.toLowerCase()}`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
      toast.success('Merged clip downloaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloadingId(null);
    }
  }

  async function deleteMerge(m: ClipMerge) {
    if (!window.confirm(`Delete merged clip "${m.title}"?`)) return;
    try {
      await api(`/api/clip-merges/${m.id}`, { method: 'DELETE' });
      toast.success('Merged clip deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Merged Clips</h1>
          <p className="text-xs text-muted mt-0.5">
            Stitch multiple clips from any channels into one file. Pick ranges from the clip editor and queue them; render them in order here.
          </p>
        </div>
        <Link href="/clip-merges/new">
          <Button variant="gradient"><Plus /> New Merge</Button>
        </Link>
      </div>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Recent Merges</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(merges?.length ?? 0) === 0 ? (
            <div className="p-10 text-center text-sm text-muted">
              <Layers className="h-8 w-8 mx-auto mb-3 text-muted-2" />
              No merged clips yet. Add ranges to the merge queue from the clip editor, then build one here.
            </div>
          ) : (
            <table className="w-full text-sm table-fixed">
              <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
                <tr>
                  <th className="text-left px-4 py-2 w-[30%]">Title</th>
                  <th className="text-left px-4 py-2 w-[8%]">Segments</th>
                  <th className="text-left px-4 py-2 w-[14%]">Format</th>
                  <th className="text-left px-4 py-2 w-[10%]">Size</th>
                  <th className="text-left px-4 py-2 w-[12%]">Status</th>
                  <th className="text-left px-4 py-2 w-[12%]">By</th>
                  <th className="px-4 py-2 w-[14%]"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {merges!.map((m) => (
                  <tr key={m.id} className="hover:bg-panel/40 align-top">
                    <td className="px-4 py-3 font-medium">
                      <div className="truncate" title={m.title}>{m.title}</div>
                      <div className="text-[10px] text-muted-2 mt-0.5 truncate">
                        {m.segments.slice(0, 3).map((s) => s.channel.name).join(' · ')}
                        {m.segments.length > 3 ? ` · +${m.segments.length - 3} more` : ''}
                      </div>
                      {m.status === 'FAILED' && m.errorMessage && (
                        <div className="text-[11px] text-accent-red mt-1 truncate" title={m.errorMessage}>{m.errorMessage}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{m.segments.length}</td>
                    <td className="px-4 py-3"><Badge variant="outline">{m.format} · {m.resolution}</Badge></td>
                    <td className="px-4 py-3 text-xs">{m.sizeBytes ? fmtBytes(Number(m.sizeBytes)) : '—'}</td>
                    <td className="px-4 py-3">
                      {m.status === 'READY' && <Badge variant="green">READY</Badge>}
                      {m.status === 'RENDERING' && <Badge variant="cyan"><Loader2 className="h-2.5 w-2.5 animate-spin" /> RENDERING</Badge>}
                      {m.status === 'QUEUED' && <Badge variant="amber">QUEUED</Badge>}
                      {m.status === 'FAILED' && <Badge variant="red">FAILED</Badge>}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted">{m.createdBy.name}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 justify-end">
                        {m.status === 'READY' ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => downloadMerge(m)}
                            disabled={downloadingId === m.id}
                            title="Download merged clip"
                          >
                            {downloadingId === m.id
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Download className="h-3.5 w-3.5" />}
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteMerge(m)}
                          title="Delete merged clip"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
