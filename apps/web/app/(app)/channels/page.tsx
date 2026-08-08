'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { Plus, Search, Filter, Download, Circle, CircleDot, Loader2, Copy, Check, PlayCircle, StopCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { AuthImg } from '@/components/auth-img';
import { api } from '@/lib/api';
import { CHANNEL_CATEGORIES, CHANNEL_LANGUAGES } from '@cmc/shared';
import { toast } from 'sonner';

interface Channel {
  id: string; slug: string; name: string;
  category: string; language: string; active: boolean;
  logoUrl: string | null;
  recordingEnabled: boolean;
  /** Single source per channel — CMC has no failover. `sourceUrl` is
   * the raw UDP/RTP URL exactly as the operator entered it. */
  sourceUrl: string | null;
  sourceKind: string | null;
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

  const bulkRecordMut = useMutation({
    mutationFn: async (enable: boolean) => {
      const targets = rows.filter((c) => c.active && c.recordingEnabled !== enable);
      // Parallel PATCH — 30 requests take ~1s all together.
      await Promise.all(targets.map((c) =>
        api(`/api/channels/${c.id}`, { method: 'PATCH', body: { recordingEnabled: enable } }),
      ));
      return targets.length;
    },
    onSuccess: (count, enable) => {
      qc.invalidateQueries({ queryKey: ['channels'] });
      toast.success(`${enable ? 'Started' : 'Stopped'} recording on ${count} channel${count === 1 ? '' : 's'}`);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Bulk toggle failed'),
  });

  const recordingCount = useMemo(() => rows.filter((c) => c.recordingEnabled).length, [rows]);

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Channels</h1>
          <p className="text-xs text-muted mt-0.5">Configure channels, sources, and failover.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            className="text-green-600 hover:text-green-700"
            onClick={() => bulkRecordMut.mutate(true)}
            disabled={bulkRecordMut.isPending}
            title="Enable recordingEnabled on every active channel"
          >
            {bulkRecordMut.isPending && bulkRecordMut.variables === true
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <PlayCircle className="h-4 w-4" />}
            Start all recording
          </Button>
          <Button
            variant="secondary"
            className="text-red-600 hover:text-red-700"
            onClick={() => bulkRecordMut.mutate(false)}
            disabled={bulkRecordMut.isPending || recordingCount === 0}
            title={recordingCount === 0 ? 'No channels are currently recording' : `Stop recording on all ${recordingCount} channels`}
          >
            {bulkRecordMut.isPending && bulkRecordMut.variables === false
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <StopCircle className="h-4 w-4" />}
            Stop all recording ({recordingCount})
          </Button>
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
                <th className="text-left px-4 py-2">Signal</th>
                <th className="text-left px-4 py-2">Source URL</th>
                <th className="text-left px-4 py-2">Recording</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}><td colSpan={6} className="px-4 py-3"><div className="h-6 bg-panel2/50 rounded animate-pulse" /></td></tr>
                ))
              )}
              {!isLoading && rows.map((c) => {
                // Unified two-state signal: LIVE iff operator marked
                // the channel active AND a source URL is configured;
                // otherwise OFFLINE. Previously we split OFFLINE (no
                // source) vs DISABLED (active=false) but from an
                // operational view a sourceless channel is just as
                // offline regardless of the active flag — showing two
                // different labels for the same practical state was
                // just noise.
                const hasSource = !!c.sourceUrl;
                const live = c.active && hasSource;
                const signal: 'LIVE' | 'OFFLINE' = live ? 'LIVE' : 'OFFLINE';
                const signalVariant: 'green' | 'red' = live ? 'green' : 'red';
                return (
                  <tr
                    key={c.id}
                    onClick={() => router.push(`/channels/${c.id}`)}
                    className="hover:bg-panel2/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded bg-white border border-border overflow-hidden flex items-center justify-center font-display font-bold text-[12px] text-muted">
                          {c.logoUrl
                            ? <AuthImg src={c.logoUrl} alt="" className="max-w-full max-h-full object-contain"
                                       fallback={<span>{c.name.slice(0,2).toUpperCase()}</span>} />
                            : <span className="text-muted">{c.name.slice(0,2).toUpperCase()}</span>}
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
                      <div className="flex flex-col gap-1 items-start">
                        <Badge variant={signalVariant}>{signal}</Badge>
                      </div>
                    </td>
                    <td className="px-4 py-3 max-w-[24rem]">
                      <SourceUrlCell url={c.sourceUrl} kind={c.sourceKind} />
                    </td>
                    <td className="px-4 py-3">
                      <RecordingToggle channel={c} />
                    </td>
                  </tr>
                );
              })}
              {!isLoading && rows.length === 0 && (
                <tr><td colSpan={6} className="p-10 text-center text-muted text-sm">
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
  // Track whether the operator has manually edited the slug. Without
  // this, the prior `slug: f.slug || derive(name)` shortcut froze the
  // slug at the first character typed into name (because after the
  // first update f.slug is truthy so subsequent name changes stop
  // regenerating). Now: if the slug field is untouched, keep deriving
  // from the name on every keystroke; if the user typed into slug
  // themselves, respect their value.
  const [slugTouched, setSlugTouched] = useState(false);
  const deriveSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
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
            <Input
              required
              value={form.name}
              onChange={(e) => setForm((f) => ({
                ...f,
                name: e.target.value,
                slug: slugTouched ? f.slug : deriveSlug(e.target.value),
              }))}
              placeholder="GEO News"
            />
          </div>
          <div className="col-span-2 space-y-1.5">
            <Label>Slug</Label>
            <Input
              required
              pattern="[a-z0-9-]+"
              value={form.slug}
              onChange={(e) => {
                setSlugTouched(true);
                setForm((f) => ({ ...f, slug: e.target.value }));
              }}
              placeholder="geo-news"
            />
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

/** Truncated source URL + copy-to-clipboard button. Empty state shown
 *  when no source is configured (channel row is effectively OFFLINE). */
function SourceUrlCell({ url, kind }: { url: string | null; kind: string | null }) {
  const [copied, setCopied] = useState(false);
  if (!url) return <span className="text-xs text-muted-2 italic">no source</span>;
  async function copy(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!url) return;
    // navigator.clipboard.writeText requires a secure context (HTTPS
    // or localhost). The CMC wall runs on http://10.51.80.202:8080 so
    // Chrome throws "The Clipboard API has been blocked because of a
    // permissions policy" and our old copy() showed a false failure
    // toast. Fallback to the older textarea + execCommand which every
    // browser still supports and doesn't care about origin.
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url);
        ok = true;
      }
    } catch { /* fall through to legacy */ }
    if (!ok) {
      try {
        const ta = document.createElement('textarea');
        ta.value = url;
        ta.style.position = 'fixed';
        ta.style.left = '-1000px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand('copy');
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } else {
      toast.error('Copy failed — select and Ctrl+C manually');
    }
  }
  return (
    <div className="flex items-center gap-1.5 max-w-full">
      {kind ? <Badge variant="outline" className="shrink-0">{kind}</Badge> : null}
      <code className="text-[11px] font-mono text-muted truncate min-w-0 flex-1">{url}</code>
      <button
        onClick={copy}
        className={cn(
          'shrink-0 rounded p-1 transition',
          copied ? 'text-green-500' : 'text-muted-2 hover:text-txt hover:bg-panel2',
        )}
        title={copied ? 'Copied' : 'Copy URL'}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
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
