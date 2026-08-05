'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  Radio, Tv2, Scissors, Film, HardDrive,
  CheckCircle2, AlertCircle, XCircle, ArrowUpRight,
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { HealthMeter } from '@/components/health-meter';
import { ViewerDownloadCard } from '@/components/viewer-download-card';
import { api } from '@/lib/api';
import { cn, fmtBytes } from '@/lib/utils';

interface Kpis {
  channels: number; sources: number; activeChannels: number; channelsWithSource: number;
  clipsToday: number; segmentsToday: number;
  users: number;
  bytesWritten24h: number; onAirMinutes24h: number;
  health: Array<{ id: string; name: string; slug: string; active: boolean; category: string; hasSource: boolean; score: number | null; activeSourceId: string | null }>;
  recentAudit: Array<{ id: string; action: string; entityType: string | null; createdAt: string; user: { name: string; email: string } | null }>;
}

export default function DashboardPage() {
  const { data: kpis } = useQuery<Kpis>({
    queryKey: ['dashboard.kpis'],
    queryFn: () => api<Kpis>('/api/dashboard/kpis'),
    refetchInterval: 10_000,
  });

  // CMC has no failover-controller writing scores; a null score on an
  // active-with-source channel means "no live signal, trust the config"
  // and should count as UP, not IDLE. down/warn only apply when a real
  // (non-null) score puts them there.
  const up   = kpis?.health.filter((c) => c.active && c.hasSource && (c.score === null || c.score >= 0.5)).length ?? 0;
  const warn = kpis?.health.filter((c) => c.active && c.hasSource && c.score !== null && c.score < 0.5 && c.score >= 0.25).length ?? 0;
  const down = kpis?.health.filter((c) => c.active && c.hasSource && c.score !== null && c.score < 0.25).length ?? 0;
  const idle = kpis?.health.filter((c) => c.active && !c.hasSource).length ?? 0;

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
          <span className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-accent-green" /> <span className="text-txt font-semibold">{up}</span> up</span>
          <span className="w-px h-3 bg-line" />
          <span className="flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5 text-accent-amber" /> <span className="text-txt font-semibold">{warn}</span> degraded</span>
          <span className="w-px h-3 bg-line" />
          <span className="flex items-center gap-1.5"><XCircle className="h-3.5 w-3.5 text-accent-red" /> <span className="text-txt font-semibold">{down}</span> down</span>
          {idle > 0 && <><span className="w-px h-3 bg-line" /><span><span className="text-txt font-semibold">{idle}</span> idle</span></>}
        </div>
      </div>

      <ViewerDownloadCard />

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
        <Kpi title="Channels"     value={kpis?.channels}      icon={Tv2}       accent="brand"  subline={`${kpis?.channelsWithSource ?? 0} with a source`} />
        <Kpi title="Sources"      value={kpis?.sources}       icon={Radio}     accent="cyan" />
        <Kpi title="Segments 24h" value={kpis?.segmentsToday} icon={Film}      accent="green"  subline={`${kpis?.onAirMinutes24h ?? 0} on-air min`} />
        <Kpi title="Data written" value={kpis ? fmtBytes(kpis.bytesWritten24h) : '—'} icon={HardDrive} accent="amber" subline="last 24h" />
        <Kpi title="Clips 24h"    value={kpis?.clipsToday}    icon={Scissors}  accent="purple" />
      </div>

      <Card className="card-glow">
        <CardHeader className="flex-row items-center justify-between">
          <div>
            <CardTitle>Channel Health</CardTitle>
            <p className="text-xs text-muted mt-1">Live per-channel status.</p>
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
                  {/* Same "trust config" rule as the counters above:
                      active + has-source with no live score → treat as
                      healthy (1.0). No source → 0 (visibly empty). */}
                  <HealthMeter
                    value={c.score ?? (c.active && c.hasSource ? 1 : 0)}
                    size="sm"
                  />
                  <Badge variant="outline" className="text-[9px] px-1 py-0">{c.category?.slice(0, 3) ?? '—'}</Badge>
                </div>
                <div className="text-[11px] mt-1.5 font-medium truncate">{c.name}</div>
              </Link>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
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
