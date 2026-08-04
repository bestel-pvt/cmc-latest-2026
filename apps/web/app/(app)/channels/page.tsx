'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Plus, Search, Radio, Filter, Download, Copy, Check, Circle, CircleDot, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { HealthMeter } from '@/components/health-meter';
import { api } from '@/lib/api';
import { CHANNEL_CATEGORIES, CHANNEL_LANGUAGES } from '@cmc/shared';
import { toast } from 'sonner';

interface Channel {
  id: string; slug: string; name: string;
  category: string; language: string; active: boolean;
  aiFeaturesEnabled: boolean;
  recordingEnabled: boolean;
  dempOutputUrl: string | null;                // primary (UDP if configured, else RTSP)
  dempOutputUrlUdp: string | null;             // multicast UDP for same-LAN VLC
  dempOutputUrlRtsp: string | null;            // RTSP for remote / Tailscale VLC
  sources: Array<{ id: string; name: string; url: string; kind: string; isPrimary: boolean }>;
  runtime?: { score: number | null; activeSourceId: string | null };
}

function CopyBtn({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();                          // don't trigger the row click
    // Clipboard API requires HTTPS or localhost. Fall back to execCommand for HTTP LAN.
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = value; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    setCopied(true); setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button title="Copy" onClick={copy} className="text-muted-2 hover:text-brand">
      {copied ? <Check className="h-3 w-3 text-accent-green" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

export default function ChannelsPage() {
  const qc = useQueryClient();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | 'all'>('all');
  const [language, setLanguage] = useState<string | 'all'>('all');
  const [creating, setCreating] = useState(false);

  const { data: channels, isLoading } = useQuery<Channel[]>({
    queryKey: ['channels', q, category, language],
    queryFn: () => {
      const p = new URLSearchParams();
      if (q) p.set('q', q);
      if (category !== 'all') p.set('category', category);
      if (language !== 'all') p.set('language', language);
      return api<Channel[]>(`/api/channels${p.toString() ? `?${p}` : ''}`);
    },
    refetchInterval: 30_000,
  });

  const rows = useMemo(() => channels ?? [], [channels]);

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/channels', { method: 'POST', body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['channels'] }); toast.success('Channel created'); setCreating(false); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Channels</h1>
          <p className="text-xs text-muted mt-0.5">Configure channels, sources, and failover.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={async () => {
            // Auth-aware CSV download: <a href> can't send Authorization
            // headers, so fetch as blob and save via anchor click.
            try {
              const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
              const r = await fetch('/api/channels/export.csv', {
                headers: token ? { Authorization: `Bearer ${token}` } : {},
              });
              if (!r.ok) throw new Error(`HTTP ${r.status}`);
              const blob = await r.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `demp-channels-${new Date().toISOString().slice(0, 10)}.csv`;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
              toast.success('CSV downloaded');
            } catch (e) {
              toast.error(e instanceof Error ? e.message : 'Export failed');
            }
          }}><Download /> Export CSV</Button>
          <Button variant="gradient" onClick={() => setCreating(true)}>
            <Plus /> New Channel
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or slug" className="pl-9" />
          </div>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="w-40"><SelectValue placeholder="Category" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CHANNEL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={language} onValueChange={setLanguage}>
            <SelectTrigger className="w-36"><SelectValue placeholder="Language" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              {CHANNEL_LANGUAGES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
          <div className="text-xs text-muted-2 ml-auto">
            <Filter className="inline h-3 w-3 mr-1" /> {rows.length} shown
          </div>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto scrollbar-thin">
          <table className="w-full text-sm">
            <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
              <tr>
                <th className="text-left px-4 py-2">Channel</th>
                <th className="text-left px-4 py-2">Category</th>
                <th className="text-left px-4 py-2">Lang</th>
                <th className="text-left px-4 py-2">Sources</th>
                <th className="text-left px-4 py-2">CMC stream (VLC)</th>
                <th className="text-left px-4 py-2 w-56">Health</th>
                <th className="text-left px-4 py-2">Signal</th>
                <th className="text-left px-4 py-2">Recording</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={8} className="px-4 py-3"><div className="h-6 bg-panel2/50 rounded animate-pulse" /></td></tr>
                ))
              )}
              {!isLoading && rows.map((c) => {
                const activeId = c.runtime?.activeSourceId;
                const score = c.runtime?.score ?? null;
                // "Signal" reflects what's ACTUALLY happening on the wire —
                // not whether the channel is enabled in config.
                const signal: 'LIVE' | 'DEGRADED' | 'OFFLINE' | 'DISABLED' =
                  !c.active ? 'DISABLED' :
                  score === null ? 'OFFLINE' :
                  score >= 0.5 ? 'LIVE' :
                  score >= 0.25 ? 'DEGRADED' : 'OFFLINE';
                const signalVariant: 'green' | 'amber' | 'red' | 'default' =
                  signal === 'LIVE' ? 'green' :
                  signal === 'DEGRADED' ? 'amber' :
                  signal === 'OFFLINE' ? 'red' : 'default';
                return (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/channels/${c.id}`)}
                    className="hover:bg-panel2/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded bg-panel2 border border-border flex items-center justify-center font-display font-bold text-[12px] text-muted">
                          {c.name.slice(0,2).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-sm">{c.name}</div>
                          <div className="text-[10px] uppercase tracking-widest text-muted-2">{c.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted"><Badge variant="outline">{c.category}</Badge></td>
                    <td className="px-4 py-3 text-muted"><Badge variant="outline">{c.language}</Badge></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-0.5 text-xs">
                        {c.sources.map((s) => {
                          const isActive = s.id === activeId;
                          return (
                            <div key={s.id} className={cn('flex items-center gap-1.5', isActive && 'font-semibold text-accent-green')}>
                              <Radio className={cn('h-3 w-3 shrink-0', isActive ? 'text-accent-green' : 'text-muted-2')} />
                              <span>{s.name || s.kind}</span>
                              <span className="text-muted-2 font-mono truncate max-w-[220px]" title={s.url}>{s.url}</span>
                            </div>
                          );
                        })}
                        {c.sources.length === 0 && <span className="text-muted-2">no sources</span>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1 text-[11px] font-mono">
                        {c.dempOutputUrlUdp ? (
                          <div className="flex items-center gap-1.5" title="Multicast UDP — same-LAN VLC clients only; won't work over Tailscale/VPN">
                            <Badge variant="outline" className="text-[9px] px-1 py-0">UDP</Badge>
                            <span className="truncate max-w-[220px]" title={c.dempOutputUrlUdp}>{c.dempOutputUrlUdp}</span>
                            <CopyBtn value={c.dempOutputUrlUdp} />
                          </div>
                        ) : (
                          <span className="text-muted-2">—</span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3"><HealthMeter value={score} label size="sm" /></td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1 items-start">
                        <Badge variant={signalVariant}>{signal}</Badge>
                        {c.aiFeaturesEnabled && <Badge variant="brand">AI</Badge>}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <RecordingToggle channel={c} />
                    </td>
                  </tr>
                );
              })}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={8} className="p-10 text-center text-muted text-sm">
                  No channels yet. Use <b>New Channel</b> to add your first one.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <CreateChannelDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSubmit={(data) => createMut.mutate(data as Record<string, unknown>)}
        submitting={createMut.isPending}
      />
    </div>
  );
}

function CreateChannelDialog({
  open, onClose, onSubmit, submitting,
}: {
  open: boolean; onClose: () => void;
  onSubmit: (data: unknown) => void; submitting: boolean;
}) {
  const [form, setForm] = useState({ name: '', slug: '', category: 'NEWS', language: 'UR' });
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create channel</DialogTitle>
          <DialogDescription>Define a channel; add sources on the detail page.</DialogDescription>
        </DialogHeader>
        <form
          className="grid grid-cols-2 gap-4"
          onSubmit={(e) => { e.preventDefault(); onSubmit(form); }}
        >
          <div className="col-span-2 space-y-1.5">
            <Label>Name</Label>
            <Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value, slug: f.slug || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') }))} placeholder="GEO News" />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>Slug</Label>
            <Input required pattern="[a-z0-9-]+" value={form.slug} onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))} placeholder="geo-news" />
          </div>
          <div className="space-y-1.5">
            <Label>Category</Label>
            <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CHANNEL_CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Language</Label>
            <Select value={form.language} onValueChange={(v) => setForm((f) => ({ ...f, language: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{CHANNEL_LANGUAGES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <DialogFooter className="col-span-2 mt-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="gradient" disabled={submitting}>Create channel</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * In-row start/stop recording toggle. Optimistic UI update on click so
 * the badge flips immediately; a query invalidation refetches actual state.
 */
function RecordingToggle({ channel }: { channel: Channel }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState(false);
  const isRecording = channel.recordingEnabled;

  async function toggle(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPending(true);
    try {
      await api(`/api/channels/${channel.id}`, { method: 'PATCH', body: { recordingEnabled: !isRecording } });
      toast.success(isRecording ? 'Recording stopped' : 'Recording started');
      qc.invalidateQueries({ queryKey: ['channels'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      onClick={toggle}
      disabled={pending}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-semibold uppercase tracking-widest transition-colors',
        isRecording
          ? 'bg-accent-red/10 text-accent-red hover:bg-accent-red/20 ring-1 ring-accent-red/30'
          : 'bg-panel2 text-muted hover:bg-panel2 hover:text-txt ring-1 ring-line',
      )}
      title={isRecording ? 'Recording — click to stop' : 'Not recording — click to start'}
    >
      {pending ? <Loader2 className="h-3 w-3 animate-spin" /> :
        isRecording ? <CircleDot className="h-3 w-3 animate-pulse" /> : <Circle className="h-3 w-3" />}
      {isRecording ? 'REC' : 'OFF'}
    </button>
  );
}
