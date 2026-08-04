'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Save, WifiOff, Clock, Cpu, ShieldCheck } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { api } from '@/lib/api';

export default function SettingsPage() {
  const qc = useQueryClient();
  const { data } = useQuery<Record<string, unknown>>({
    queryKey: ['settings'], queryFn: () => api<Record<string, unknown>>('/api/settings'),
  });
  const [state, setState] = useState<Record<string, unknown>>({});
  useEffect(() => { if (data) setState(data); }, [data]);

  const saveMut = useMutation({
    mutationFn: (body: Record<string, unknown>) => api('/api/settings', { method: 'PATCH', body }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); toast.success('Settings saved'); },
  });

  function set<K extends string>(key: K, value: unknown) {
    setState((s) => ({ ...s, [key]: value }));
  }

  return (
    <div className="max-w-[1000px] mx-auto space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-xs text-muted mt-0.5">System-wide policies. Every change is audit-logged.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Clock className="h-4 w-4 text-brand" /> Retention</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Retention days</Label>
              <Input type="number" min={7} max={365} value={Number(state['retention.days'] ?? 30)} onChange={(e) => set('retention.days', Number(e.target.value))} />
              <p className="text-[11px] text-muted-2 mt-1">Segments older than this are deleted by the janitor (unless covered by a legal hold).</p>
            </div>
            <div>
              <Label>Recording segment length (seconds)</Label>
              <Input type="number" min={10} max={600} value={Number(state['recording.segmentSec'] ?? 60)} onChange={(e) => set('recording.segmentSec', Number(e.target.value))} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><Cpu className="h-4 w-4 text-brand" /> AI models</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label>Whisper model tier</Label>
              <Select value={String(state['whisper.modelTier'] ?? 'small')} onValueChange={(v) => set('whisper.modelTier', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {['tiny', 'base', 'small', 'medium', 'large-v3'].map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-2 mt-1">Larger = more accurate + more GPU per channel. Change with care.</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-brand" /> Compliance</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Watermark clip exports</Label>
                <p className="text-[11px] text-muted-2">Burns user + timestamp into every export.</p>
              </div>
              <Switch checked={Boolean(state['watermark.enabled'] ?? true)} onCheckedChange={(v) => set('watermark.enabled', v)} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2"><WifiOff className="h-4 w-4 text-brand" /> Air-gap mode</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>Enable air-gap mode</Label>
                <p className="text-[11px] text-muted-2">Disables outbound network in the UI; requires self-hosted fonts + pre-downloaded models.</p>
              </div>
              <Switch checked={Boolean(state['airGap.enabled'] ?? false)} onCheckedChange={(v) => set('airGap.enabled', v)} />
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button variant="gradient" onClick={() => saveMut.mutate(state)} disabled={saveMut.isPending}>
          <Save className="h-4 w-4" /> Save all
        </Button>
      </div>
    </div>
  );
}
