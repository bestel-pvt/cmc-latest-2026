'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GripVertical, Plus, Radio, Star, StarOff, Trash2, Zap, ScanLine, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { HealthMeter } from '@/components/health-meter';
import { Monitor as MonitorIcon } from 'lucide-react';
import { TickerRegionsEditor, type Rect } from '@/components/ticker-regions-editor';
import { LogoUploader, RecordingStatusPanel, SwitchHistoryPanel, TickerThumbGrid } from '@/components/channel-overview-panels';
import { api } from '@/lib/api';
import { SOURCE_KINDS } from '@cmc/shared';
import { cn } from '@/lib/utils';

interface Source {
  id: string; channelId: string; name: string; url: string; kind: string;
  isPrimary: boolean; priority: number; notes: string | null;
  health?: { score?: number; bitrateBps?: number; packetLossPct?: number; blackPct?: number } | null;
}
interface Channel {
  id: string; slug: string; name: string; category: string; language: string; active: boolean;
  aiFeaturesEnabled: boolean;
  logoUrl: string | null;
  dempOutputUrl: string | null;
  tickerCropRect: Rect | null;
  tickerPrimaryRect: Rect | null;
  tickerSecondaryRect: Rect | null;
  flasherLeftRect: Rect | null;
  flasherRightRect: Rect | null;
  sources: Source[];
  runtime?: { score: number | null; activeSourceId: string | null };
}


export default function ChannelDetailPage() {
  const { id } = useParams() as { id: string };
  const qc = useQueryClient();
  const { data: ch, isLoading } = useQuery<Channel>({
    queryKey: ['channel', id],
    queryFn: () => api<Channel>(`/api/channels/${id}`),
    refetchInterval: 5_000,
  });

  const [newSrc, setNewSrc] = useState({ name: '', url: '', kind: 'UDP', isPrimary: false });

  const addSource = useMutation({
    mutationFn: () => api('/api/sources', { method: 'POST', body: { channelId: id, ...newSrc } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel', id] }); toast.success('Source added'); setNewSrc({ name: '', url: '', kind: 'UDP', isPrimary: false }); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const setPrimary = useMutation({
    mutationFn: (srcId: string) => api(`/api/sources/${srcId}`, { method: 'PATCH', body: { isPrimary: true } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['channel', id] }),
  });
  const removeSource = useMutation({
    mutationFn: (srcId: string) => api(`/api/sources/${srcId}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel', id] }); toast.success('Source removed'); },
  });
  const forceSwitch = useMutation({
    mutationFn: (sourceId: string) => api(`/api/channels/${id}/switch`, { method: 'POST', body: { sourceId } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel', id] }); toast.success('Switched'); },
  });
  const saveRegions = useMutation({
    mutationFn: (patch: Partial<Record<'tickerPrimaryRect' | 'tickerSecondaryRect' | 'flasherLeftRect' | 'flasherRightRect', Rect | null>>) =>
      api(`/api/channels/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channel', id] }); toast.success('Regions saved'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  if (isLoading || !ch) {
    return <div className="max-w-[1200px] mx-auto"><div className="h-64 rounded-xl bg-panel2/70 animate-pulse" /></div>;
  }

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/channels" className="text-muted hover:text-txt"><ArrowLeft className="h-4 w-4" /></Link>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-display text-2xl font-bold tracking-tight">{ch.name}</h1>
              <Badge variant="brand">{ch.category}</Badge>
              <Badge variant="outline">{ch.language}</Badge>
            </div>
            <div className="text-[11px] text-muted-2 mt-0.5 font-mono uppercase tracking-widest">/{ch.slug}</div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <LogoUploader channelId={ch.id} currentUrl={ch.logoUrl} />
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-muted-2">Rolling health</div>
            <div className="w-56"><HealthMeter value={ch.runtime?.score ?? null} label /></div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* preview */}
        <Card className="lg:col-span-2">
          <CardContent className="p-4 space-y-4">
            <div className="aspect-video w-full rounded-lg border border-line bg-panel2/40 flex flex-col items-center justify-center gap-3 text-center px-6">
              <MonitorIcon className="h-10 w-10 text-brand/70" />
              <div className="max-w-md">
                <div className="text-sm font-medium">Live playback is in the CMC Viewer desktop app</div>
                <div className="text-xs text-muted-2 mt-1">
                  Browsers can't play the satellite UDP feeds. Open <span className="font-mono">CMC-Viewer.exe</span>
                  {' '}from <a className="text-brand hover:underline" href="/downloads">Downloads</a> and pick this channel.
                </div>
              </div>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <QuickStat label="Sources" value={ch.sources.length} icon={Radio} />
              <QuickStat label="Active src"
                value={ch.sources.find((s) => s.id === ch.runtime?.activeSourceId)?.kind ?? '—'}
                icon={Zap} />
              <QuickStat label="Ticker" value={ch.tickerCropRect ? 'Cropped' : 'None'} icon={ScanLine} />
              <QuickStat label="Legal hold" value="—" icon={ShieldCheck} />
            </div>
          </CardContent>
        </Card>

        {/* sources */}
        <Card>
          <CardHeader><CardTitle>Sources &amp; Failover</CardTitle></CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y divide-border">
              {ch.sources.map((s) => (
                <li key={s.id} className={cn(
                  'px-4 py-3 flex items-center gap-3',
                  ch.runtime?.activeSourceId === s.id && 'bg-brand/5',
                )}>
                  <GripVertical className="h-4 w-4 text-muted-2 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{s.name || s.kind}</span>
                      <Badge variant="outline">{s.kind}</Badge>
                      {s.isPrimary && <Badge variant="brand">PRIMARY</Badge>}
                      {ch.runtime?.activeSourceId === s.id && <Badge variant="green">ACTIVE</Badge>}
                    </div>
                    <div className="text-xs font-mono text-muted mt-0.5 truncate">{s.url}</div>
                  </div>
                  <div className="w-24"><HealthMeter value={s.health?.score ?? null} size="sm" /></div>
                  <div className="flex items-center gap-1">
                    <button title={s.isPrimary ? 'Primary' : 'Set primary'}
                      onClick={() => setPrimary.mutate(s.id)}
                      className="text-muted hover:text-brand">
                      {s.isPrimary ? <Star className="h-4 w-4 fill-brand text-brand" /> : <StarOff className="h-4 w-4" />}
                    </button>
                    <button title="Force switch to this source"
                      onClick={() => forceSwitch.mutate(s.id)}
                      className="text-muted hover:text-accent-green"><Zap className="h-4 w-4" /></button>
                    <button title="Remove"
                      onClick={() => removeSource.mutate(s.id)}
                      className="text-muted hover:text-accent-red"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </li>
              ))}
              {ch.sources.length === 0 && <li className="p-6 text-center text-sm text-muted">No sources yet.</li>}
            </ul>

            <div className="p-4 border-t border-border space-y-2">
              <div className="text-[10px] uppercase tracking-widest text-muted-2 mb-2">Add source</div>
              <Input
                placeholder='Source name — e.g. "Satellite", "OTT Backup", "Fiber"'
                value={newSrc.name}
                onChange={(e) => setNewSrc((n) => ({ ...n, name: e.target.value }))}
                required
              />
              <div className="grid grid-cols-[100px_1fr] gap-2">
                <Select value={newSrc.kind} onValueChange={(v) => setNewSrc((n) => ({ ...n, kind: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{SOURCE_KINDS.map((k) => <SelectItem key={k} value={k}>{k}</SelectItem>)}</SelectContent>
                </Select>
                <Input placeholder="udp://@224.2.2.2:2020"
                  value={newSrc.url} onChange={(e) => setNewSrc((n) => ({ ...n, url: e.target.value }))}
                  className="font-mono text-xs" />
              </div>
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" checked={newSrc.isPrimary}
                    onChange={(e) => setNewSrc((n) => ({ ...n, isPrimary: e.target.checked }))} />
                  Set as primary
                </label>
                <Button size="sm" variant="gradient" onClick={() => addSource.mutate()} disabled={!newSrc.name.trim() || !newSrc.url.trim()}>
                  <Plus className="h-3.5 w-3.5" /> Add source
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Everything view — recording status + switches + tickers */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <RecordingStatusPanel channelId={ch.id} aiEnabled={ch.aiFeaturesEnabled} />
        <SwitchHistoryPanel channelId={ch.id} sources={ch.sources} />
      </div>
      <TickerThumbGrid channelId={ch.id} aiEnabled={ch.aiFeaturesEnabled} />

      {/* Regions editor */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4 text-brand" /> Ticker &amp; Flasher Regions
          </CardTitle>
          <p className="text-xs text-muted mt-1">
            Grab a fresh freeze frame and draw rectangles for each on-screen zone.
            The OCR worker reads exactly what you box; everything else is ignored.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <TickerRegionsEditor
            channelId={ch.id}
            initial={{
              tickerPrimaryRect:   ch.tickerPrimaryRect,
              tickerSecondaryRect: ch.tickerSecondaryRect,
              flasherLeftRect:     ch.flasherLeftRect,
              flasherRightRect:    ch.flasherRightRect,
            }}
            onSave={async (patch) => { await saveRegions.mutateAsync(patch); }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function QuickStat({ label, value, icon: Icon }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="rounded-lg border border-border bg-panel2/60 p-3 flex items-center gap-3">
      <div className="h-9 w-9 rounded-md bg-white border border-border flex items-center justify-center">
        <Icon className="h-4 w-4 text-brand" />
      </div>
      <div>
        <div className="text-[10px] uppercase tracking-widest text-muted-2">{label}</div>
        <div className="font-display font-semibold text-sm">{value}</div>
      </div>
    </div>
  );
}
