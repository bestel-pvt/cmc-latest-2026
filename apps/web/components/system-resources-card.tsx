'use client';

import { useQuery } from '@tanstack/react-query';
import { Cpu, MemoryStick, HardDrive, Timer } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { api } from '@/lib/api';
import { fmtBytes } from '@/lib/utils';

interface SystemStats {
  at: string;
  cpu: { cores: number; model: string; loadAvg: { m1: number; m5: number; m15: number }; loadPct1m: number };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usedPct: number };
  disk: { total: number; used: number; available: number; mount: string; usedPct: number };
  recordingsBytes: number;
  uptimeSec: number;
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Live server resources — polled every 5 s. */
export function SystemResourcesCard() {
  const { data } = useQuery<SystemStats>({
    queryKey: ['dashboard.system'],
    queryFn: () => api<SystemStats>('/api/dashboard/system'),
    refetchInterval: 5_000,
  });
  if (!data) return null;
  const cpu = data.cpu.loadPct1m;
  const mem = data.memory.usedPct;
  const dsk = data.disk.usedPct;
  const bar = (pct: number) =>
    pct >= 85 ? 'bg-accent-red' : pct >= 65 ? 'bg-accent-amber' : 'bg-accent-green';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2"><Cpu className="h-4 w-4 text-brand" /> Server resources</CardTitle>
          <p className="text-xs text-muted mt-0.5">{data.cpu.cores} cores · uptime {formatUptime(data.uptimeSec)}</p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ResourceBar
          icon={Cpu} label="CPU load (1 min)"
          value={`${cpu}%`}
          sub={`avg ${data.cpu.loadAvg.m1.toFixed(2)} / ${data.cpu.loadAvg.m5.toFixed(2)} / ${data.cpu.loadAvg.m15.toFixed(2)}`}
          pct={cpu} color={bar(cpu)}
        />
        <ResourceBar
          icon={MemoryStick} label="Memory"
          value={`${mem}%`}
          sub={`${fmtBytes(data.memory.usedBytes)} / ${fmtBytes(data.memory.totalBytes)}`}
          pct={mem} color={bar(mem)}
        />
        <ResourceBar
          icon={HardDrive} label={`Disk · ${data.disk.mount}`}
          value={`${dsk}%`}
          sub={`${fmtBytes(data.disk.used)} used · ${fmtBytes(data.disk.available)} free`}
          pct={dsk} color={bar(dsk)}
        />
        <div className="flex items-center justify-between text-xs text-muted-2 pt-1 border-t border-line">
          <span className="flex items-center gap-1.5"><Timer className="h-3 w-3" /> Recordings on disk</span>
          <span className="font-mono">{fmtBytes(data.recordingsBytes)}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function ResourceBar({ icon: Icon, label, value, sub, pct, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string; value: string; sub: string; pct: number; color: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="flex items-center gap-2 text-muted-2">
          <Icon className="h-3.5 w-3.5 text-brand" /> {label}
        </span>
        <span className="font-mono font-semibold">{value}</span>
      </div>
      <div className="h-2 rounded-full overflow-hidden bg-panel2">
        <div className={`h-full transition-all ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="text-[10px] text-muted-2 mt-1 font-mono">{sub}</div>
    </div>
  );
}
