'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Shield } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { api } from '@/lib/api';

interface Hold {
  id: string; startsAt: string; endsAt: string; reason: string; active: boolean;
  channel: { id: string; name: string; slug: string } | null;
  createdBy: { name: string };
}
interface Channel { id: string; name: string; slug: string }

export default function LegalHoldsPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ channelId: '', startsAt: '', endsAt: '', reason: '' });

  const { data: holds } = useQuery<Hold[]>({
    queryKey: ['holds'], queryFn: () => api<Hold[]>('/api/legal-holds'),
  });
  const { data: channels } = useQuery<Channel[]>({
    queryKey: ['channels.for-holds'], queryFn: () => api<Channel[]>('/api/channels'),
  });

  const createMut = useMutation({
    mutationFn: () => api('/api/legal-holds', {
      method: 'POST',
      body: {
        channelId: form.channelId || null,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt:   new Date(form.endsAt).toISOString(),
        reason: form.reason,
      },
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['holds'] }); setOpen(false); toast.success('Legal hold created'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const expireMut = useMutation({
    mutationFn: (id: string) => api(`/api/legal-holds/${id}/expire`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['holds'] }),
  });

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Legal Holds</h1>
          <p className="text-xs text-muted mt-0.5">Recordings inside an active hold window are exempt from the 30-day janitor.</p>
        </div>
        <Button variant="gradient" onClick={() => setOpen(true)}><Plus /> New hold</Button>
      </div>

      <Card>
        <CardHeader><CardTitle>Active & recent holds</CardTitle></CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
              <tr>
                <th className="text-left px-4 py-2">Scope</th>
                <th className="text-left px-4 py-2">Window</th>
                <th className="text-left px-4 py-2">Reason</th>
                <th className="text-left px-4 py-2">Created by</th>
                <th className="text-left px-4 py-2">Status</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(holds ?? []).map((h) => (
                <tr key={h.id} className="align-top">
                  <td className="px-4 py-3">{h.channel ? h.channel.name : <em className="text-muted">All channels</em>}</td>
                  <td className="px-4 py-3 text-xs font-mono">{new Date(h.startsAt).toISOString().slice(0,16)} → {new Date(h.endsAt).toISOString().slice(0,16)}</td>
                  <td className="px-4 py-3 text-sm max-w-md">{h.reason}</td>
                  <td className="px-4 py-3 text-xs text-muted">{h.createdBy.name}</td>
                  <td className="px-4 py-3">{h.active ? <Badge variant="brand"><Shield className="h-2.5 w-2.5" /> ACTIVE</Badge> : <Badge variant="outline">EXPIRED</Badge>}</td>
                  <td className="px-4 py-3">
                    {h.active && <Button size="sm" variant="secondary" onClick={() => expireMut.mutate(h.id)}>Expire</Button>}
                  </td>
                </tr>
              ))}
              {(holds?.length ?? 0) === 0 && (
                <tr><td colSpan={6} className="p-10 text-center text-sm text-muted"><Shield className="h-8 w-8 mx-auto mb-3 text-muted-2" />No holds yet.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={(v) => !v && setOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create legal hold</DialogTitle>
            <DialogDescription>Prevents deletion of any recording overlapping this window.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); createMut.mutate(); }}>
            <div>
              <Label>Scope</Label>
              <Select value={form.channelId} onValueChange={(v) => setForm((f) => ({ ...f, channelId: v === '__all' ? '' : v }))}>
                <SelectTrigger><SelectValue placeholder="Choose channel…" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all">All channels</SelectItem>
                  {(channels ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Starts at (UTC)</Label><Input type="datetime-local" required value={form.startsAt} onChange={(e) => setForm((f) => ({ ...f, startsAt: e.target.value }))} /></div>
              <div><Label>Ends at (UTC)</Label>  <Input type="datetime-local" required value={form.endsAt}   onChange={(e) => setForm((f) => ({ ...f, endsAt: e.target.value }))} /></div>
            </div>
            <div><Label>Reason</Label><Input required value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} placeholder="Case reference / directive" /></div>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" variant="gradient">Create hold</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
