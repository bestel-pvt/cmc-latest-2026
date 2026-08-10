'use client';

/**
 * Dashboard — the operator's home page. Two panes:
 *   1. Operational KPIs: channels / active / recording / segments 24 h /
 *      data written 24 h / clips 24 h.
 *   2. Server resources: CPU / memory / disk (with per-workload
 *      breakdown for recordings, clips, frames).
 *
 * No AI features, no failover controller, no ticker/flasher counters,
 * no viewer-download card — CMC is trimmed to the shipping surface.
 */

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  Radio, Tv2, Scissors, Film, HardDrive, Cpu, MemoryStick, Server, ArrowUpRight,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';
import { cn, fmtBytes } from '@/lib/utils';

interface Kpis {
  channels: number; activeChannels: number; channelsWithSource: number;
  recordingEnabled: number;
  clipsToday: number; segmentsToday: number; bytesWritten24h: number;
  users: number;
  health: Array<{ id: string; name: string; slug: string; active: boolean; hasSource: boolean; category: string; recordingEnabled: boolean }>;
}
interface Resources {
  at: string;
  cpu:    { cores: number; model: string; usedPct: number };
  memory: { totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number };
  disk:   {
    mount: string;
    totalBytes: number; usedBytes: number; freeBytes: number; usedPct: number;
    breakdown: { recordingsBytes: number; clipsBytes: number; framesBytes: number; otherBytes: number };
    volumes?: Array<{ mount: string; total: number; free: number; used: number }>;
  };
  uptimeSec: number;
}

export default function DashboardPage() {
  const { data: kpis } = useQuery<Kpis>({
    queryKey: ['dashboard.kpis'],
    queryFn: () => api<Kpis>('/api/dashboard/kpis'),
    refetchInterval: 30_000,
  });
  const { data: res } = useQuery<Resources>({
    queryKey: ['dashboard.resources'],
    queryFn: () => api<Resources>('/api/dashboard/resources'),
    refetchInterval: 30_000,
  });

  // Same unified 2-state model as the channels page: LIVE iff active
  // + has a source; everything else is OFFLINE. No separate "disabled"
  // bucket — from an ops POV a sourceless channel is offline.
  const live    = kpis?.health.filter((c) => c.active && c.hasSource).length ?? 0;
  const offline = kpis?.health ? kpis.health.length - live : 0;

  return (
    <div className="max-w-[1500px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full border border-accent-green/30 bg-accent-green/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-widest text-accent-green">
            <span className="h-1.5 w-1.5 rounded-full bg-accent-green shadow-glow" />
            Live Operations
          </div>
          <h1 className="mt-3 font-display text-3xl font-bold tracking-tight">
            Pakistan Navy <span className="bg-g-brand bg-clip-text text-transparent">Channel Monitoring &amp; Clipping</span>
          </h1>
          <p className="mt-1 text-sm text-muted">
            {kpis?.channels ?? '—'} channels · real-time ingest, recording, and clipping.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-2 bg-white border border-line rounded-md px-3 py-2 shadow-soft">
          <span><span className="text-txt font-semibold">{live}</span> live</span>
          <span className="w-px h-3 bg-line" />
          <span><span className="text-txt font-semibold">{offline}</span> offline</span>
        </div>
      </div>

      {/* Operational KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi title="Channels"          value={kpis?.channels}          icon={Tv2}      accent="brand"  subline={`${kpis?.channelsWithSource ?? 0} with a source`} />
        <Kpi title="Live"              value={live}                    icon={Radio}    accent="cyan"   subline={`${offline} offline`} />
        <Kpi title="Recording"         value={kpis?.recordingEnabled}  icon={Film}     accent="red"    subline="channels toggled on" />
        <Kpi title="Segments 24h"      value={kpis?.segmentsToday}     icon={Film}     accent="green"  subline="closed + ingested" />
        <Kpi title="Data written 24h"  value={kpis ? fmtBytes(kpis.bytesWritten24h) : '—'} icon={HardDrive} accent="amber" subline="in closed segments" />
        <Kpi title="Clips 24h"         value={kpis?.clipsToday}        icon={Scissors} accent="purple" />
      </div>

      {/* Server resources */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-2">
            <Cpu className="h-3.5 w-3.5 text-brand" /> CPU
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <div className="font-display text-3xl font-bold">{res ? `${res.cpu.usedPct}%` : '—'}</div>
            <div className="text-xs text-muted-2">{res?.cpu.cores ?? '—'} cores</div>
          </div>
          <ResourceBar pct={res?.cpu.usedPct ?? 0} />
          <div className="text-[10px] text-muted-2 mt-2 truncate">{res?.cpu.model ?? ''}</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-2">
            <MemoryStick className="h-3.5 w-3.5 text-brand" /> Memory
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <div className="font-display text-3xl font-bold">{res ? `${res.memory.usedPct}%` : '—'}</div>
            <div className="text-xs text-muted-2">
              {res ? `${fmtBytes(res.memory.usedBytes)} / ${fmtBytes(res.memory.totalBytes)}` : '—'}
            </div>
          </div>
          <ResourceBar pct={res?.memory.usedPct ?? 0} />
          <div className="text-[10px] text-muted-2 mt-2">Free: {res ? fmtBytes(res.memory.freeBytes) : '—'}</div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-2">
            <HardDrive className="h-3.5 w-3.5 text-brand" /> Storage
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <div className="font-display text-3xl font-bold">{res ? `${res.disk.usedPct}%` : '—'}</div>
            <div className="text-xs text-muted-2">
              {res ? `${fmtBytes(res.disk.usedBytes)} / ${fmtBytes(res.disk.totalBytes)}` : '—'}
            </div>
          </div>
          <ResourceBar pct={res?.disk.usedPct ?? 0} />
          {res ? (
            <div className="mt-3 space-y-1 text-[11px]">
              <BreakdownRow label="Recordings" bytes={res.disk.breakdown.recordingsBytes} total={res.disk.usedBytes} color="bg-accent-red/70" />
              <BreakdownRow label="Clips"      bytes={res.disk.breakdown.clipsBytes}      total={res.disk.usedBytes} color="bg-accent-purple/70" />
              <BreakdownRow label="Frames"     bytes={res.disk.breakdown.framesBytes}     total={res.disk.usedBytes} color="bg-accent-amber/70" />
              <BreakdownRow label="Other"      bytes={res.disk.breakdown.otherBytes}      total={res.disk.usedBytes} color="bg-muted-2/50" />
            </div>
          ) : null}
          <div className="text-[10px] text-muted-2 mt-2">Free: {res ? fmtBytes(res.disk.freeBytes) : '—'}</div>
          {res?.disk.volumes && res.disk.volumes.length > 1 ? (
            <div className="mt-3 pt-3 border-t border-line space-y-1.5 text-[11px]">
              <div className="text-[10px] uppercase tracking-widest text-muted-2 mb-1">All volumes</div>
              {res.disk.volumes.map((v) => (
                <div key={v.mount} className="flex items-center gap-2">
                  <span className="w-8 font-mono">{v.mount}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-panel2 overflow-hidden">
                    <div className={cn('h-full', v.total > 0 && v.used / v.total > 0.9 ? 'bg-accent-red' : v.total > 0 && v.used / v.total > 0.7 ? 'bg-accent-amber' : 'bg-accent-green')} style={{ width: `${v.total > 0 ? (v.used / v.total) * 100 : 0}%` }} />
                  </div>
                  <span className="text-muted-2 tabular-nums">{fmtBytes(v.used)} / {fmtBytes(v.total)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      {/* Channel Health quick grid */}
      <Card className="card-glow">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Channel Status</CardTitle>
            <p className="text-xs text-muted mt-1">
              <span className="text-txt font-medium">{kpis?.recordingEnabled ?? 0}</span> of {kpis?.channels ?? 0} channels are recording.
            </p>
          </div>
          <Link href="/channels" className="text-xs text-brand hover:underline inline-flex items-center gap-1">
            All channels <ArrowUpRight className="h-3 w-3" />
          </Link>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
            {(kpis?.health ?? []).slice(0, 40).map((c) => (
              <Link
                key={c.id}
                href={`/channels/${c.id}`}
                className={cn(
                  'border border-line rounded-md px-2 py-2 hover:border-brand/50 transition-colors bg-white',
                  !c.active && 'opacity-40',
                )}
                title={c.name}
              >
                <div className="flex items-center justify-between">
                  <span className={cn(
                    'h-2 w-2 rounded-full',
                    c.active && c.hasSource ? 'bg-accent-green' : 'bg-muted-2',
                  )} />
                  {c.recordingEnabled && <Badge variant="outline" className="text-[8px] px-1 py-0 border-accent-red/40 text-accent-red">REC</Badge>}
                </div>
                <div className="text-[11px] mt-1.5 font-medium truncate">{c.name}</div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Uptime footer */}
      <div className="text-[10px] text-muted-2 text-right">
        Server: {res?.disk.mount ?? '—'} · uptime {res ? fmtDuration(res.uptimeSec) : '—'} <Server className="inline h-3 w-3 ml-1" />
      </div>
    </div>
  );
}

function ResourceBar({ pct }: { pct: number }) {
  const color =
    pct >= 90 ? 'bg-accent-red' :
    pct >= 70 ? 'bg-accent-amber' :
                'bg-accent-green';
  return (
    <div className="mt-2 h-2 w-full rounded-full bg-panel2 overflow-hidden">
      <div className={cn('h-full transition-all', color)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function BreakdownRow({ label, bytes, total, color }: { label: string; bytes: number; total: number; color: string }) {
  const pct = total > 0 ? (bytes / total) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted">{label}</span>
        <span className="text-txt font-medium">{fmtBytes(bytes)}</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-panel2 overflow-hidden mt-0.5">
        <div className={cn('h-full', color)} style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
      </div>
    </div>
  );
}

function fmtDuration(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function Kpi({
  title, value, icon: Icon, accent, subline,
}: {
  title: string; value: string | number | undefined; icon: React.ComponentType<{ className?: string }>;
  accent: 'brand' | 'cyan' | 'green' | 'amber' | 'purple' | 'red'; subline?: string;
}) {
  const accentClass = {
    brand:  'text-brand',
    cyan:   'text-accent-cyan',
    green:  'text-accent-green',
    amber:  'text-accent-amber',
    purple: 'text-accent-purple',
    red:    'text-accent-red',
  }[accent];
  return (
    <Card className="p-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted-2">
        <Icon className={cn('h-3.5 w-3.5', accentClass)} />
        {title}
      </div>
      <div className="font-display text-2xl font-bold tracking-tight mt-1">{value ?? '—'}</div>
      {subline && <div className="text-[10px] text-muted-2 mt-0.5">{subline}</div>}
    </Card>
  );
}
