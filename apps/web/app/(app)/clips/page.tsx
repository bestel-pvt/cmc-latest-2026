'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Download, Loader2, Film } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { fmtBytes } from '@/lib/utils';

interface Clip {
  id: string; title: string; status: 'QUEUED' | 'RENDERING' | 'READY' | 'FAILED';
  format: string; resolution: string; sizeBytes: string | null;
  startAt: string; endAt: string; createdAt: string;
  channel: { name: string; slug: string };
  createdBy: { name: string };
}

export default function ClipsPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 6);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState<string>(today);

  const { data: clips } = useQuery<Clip[]>({
    queryKey: ['clips', from, to],
    queryFn: () => {
      const p = new URLSearchParams();
      p.set('limit', '500');
      p.set('from', new Date(from + 'T00:00:00Z').toISOString());
      p.set('to',   new Date(to   + 'T23:59:59Z').toISOString());
      return api<Clip[]>(`/api/clips?${p}`);
    },
    refetchInterval: 5_000,
  });

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Clips</h1>
          <p className="text-xs text-muted mt-0.5">Trim, watermark, and export moments from any recording.</p>
        </div>
        <Link href="/clips/new">
          <Button variant="gradient"><Plus /> New Clip</Button>
        </Link>
      </div>

      <Card className="p-3">
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <label className="flex items-center gap-2">
            <span className="text-muted-2 uppercase tracking-widest text-[10px]">From</span>
            <input type="date" value={from} max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 px-2 rounded-md border border-line bg-white font-mono" />
          </label>
          <label className="flex items-center gap-2">
            <span className="text-muted-2 uppercase tracking-widest text-[10px]">To</span>
            <input type="date" value={to} min={from} max={today}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 px-2 rounded-md border border-line bg-white font-mono" />
          </label>
          <button onClick={() => { setFrom(today); setTo(today); }}
            className="h-7 px-3 rounded-md border border-line hover:border-brand/40">Today</button>
          <button onClick={() => {
            const d = new Date(); d.setUTCDate(d.getUTCDate() - 6);
            setFrom(d.toISOString().slice(0, 10)); setTo(today);
          }} className="h-7 px-3 rounded-md border border-line hover:border-brand/40">Last 7d</button>
          <button onClick={() => {
            const d = new Date(); d.setUTCDate(d.getUTCDate() - 29);
            setFrom(d.toISOString().slice(0, 10)); setTo(today);
          }} className="h-7 px-3 rounded-md border border-line hover:border-brand/40">30d</button>
          <div className="ml-auto text-muted-2">{clips?.length ?? 0} clips</div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <CardHeader>
          <CardTitle>Recent Clips</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(clips?.length ?? 0) === 0 ? (
            <div className="p-10 text-center text-sm text-muted"><Film className="h-8 w-8 mx-auto mb-3 text-muted-2" />No clips yet.</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
                <tr>
                  <th className="text-left px-4 py-2">Title</th>
                  <th className="text-left px-4 py-2">Channel</th>
                  <th className="text-left px-4 py-2">Duration</th>
                  <th className="text-left px-4 py-2">Format</th>
                  <th className="text-left px-4 py-2">Size</th>
                  <th className="text-left px-4 py-2">Status</th>
                  <th className="text-left px-4 py-2">By</th>
                  <th className="px-4 py-2 w-20"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {clips!.map((c) => {
                  const dur = (new Date(c.endAt).getTime() - new Date(c.startAt).getTime()) / 1000;
                  return (
                    <tr key={c.id} className="hover:bg-panel/40">
                      <td className="px-4 py-3 font-medium">{c.title}</td>
                      <td className="px-4 py-3 text-muted">{c.channel.name}</td>
                      <td className="px-4 py-3 font-mono text-xs">{Math.floor(dur)}s</td>
                      <td className="px-4 py-3"><Badge variant="outline">{c.format} · {c.resolution}</Badge></td>
                      <td className="px-4 py-3 text-xs">{c.sizeBytes ? fmtBytes(Number(c.sizeBytes)) : '—'}</td>
                      <td className="px-4 py-3">
                        {c.status === 'READY' && <Badge variant="green">READY</Badge>}
                        {c.status === 'RENDERING' && <Badge variant="cyan"><Loader2 className="h-2.5 w-2.5 animate-spin" /> RENDERING</Badge>}
                        {c.status === 'QUEUED' && <Badge variant="amber">QUEUED</Badge>}
                        {c.status === 'FAILED' && <Badge variant="red">FAILED</Badge>}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted">{c.createdBy.name}</td>
                      <td className="px-4 py-3">
                        {c.status === 'READY' ? (
                          <a href={`/api/clips/${c.id}/download`}>
                            <Button variant="secondary" size="sm"><Download className="h-3.5 w-3.5" /></Button>
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
