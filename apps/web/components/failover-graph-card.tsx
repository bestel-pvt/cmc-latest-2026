'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AreaChart, Area, LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from 'recharts';
import { Activity, ArrowUpRight, Radio, RefreshCw, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';

interface Summary {
  channelId: string; name: string; slug: string;
  uptimePct: number | null; avgScore: number | null; switches: number; sparkline: number[];
}
interface Tick { at: string; sourceId: string; score: number; bitrateBps: number; isActive: boolean }

/**
 * Dashboard failover analytics card.
 *   - Per-channel summary rows with tiny sparklines + uptime %
 *   - Focused channel gets a full LineChart of per-source scores (last 6h)
 */
export function FailoverGraphCard() {
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hours, setHours] = useState<string>('6');

  const { data: summary } = useQuery<Summary[]>({
    queryKey: ['failover.summary', hours],
    queryFn: () => api<Summary[]>(`/api/failover-stats/summary?hours=${hours}`),
    refetchInterval: 30_000,
  });

  const focused = useMemo(() => {
    if (!summary || summary.length === 0) return undefined;
    if (focusedId) {
      const hit = summary.find((s) => s.channelId === focusedId);
      if (hit) return hit;
    }
    // Auto-focus the channel with the richest history so the graph is
    // populated on first render instead of showing "waiting for samples".
    const scored = summary.slice().sort((a, b) =>
      (b.sparkline?.length ?? 0) - (a.sparkline?.length ?? 0) || (b.switches ?? 0) - (a.switches ?? 0),
    );
    return scored[0];
  }, [summary, focusedId]);

  const { data: ticks } = useQuery<Tick[]>({
    queryKey: ['failover.timeseries', focused?.channelId, hours],
    queryFn: () => api<Tick[]>(`/api/failover-stats/timeseries?channelId=${focused!.channelId}&hours=${hours}`),
    enabled: !!focused?.channelId,
    refetchInterval: 15_000,
  });

  // Reshape ticks into series-per-source for the LineChart.
  const chartData = useMemo(() => {
    if (!ticks || ticks.length === 0) return [];
    const bySlot = new Map<number, Record<string, unknown>>();
    for (const t of ticks) {
      const slot = Math.floor(new Date(t.at).getTime() / (15_000)) * 15_000;   // 15s buckets
      const row = bySlot.get(slot) ?? { at: slot };
      const k = `s_${t.sourceId}`;
      // If multiple ticks land in the same bucket, keep the max
      const prev = row[k] as number | undefined;
      row[k] = prev === undefined ? t.score : Math.max(prev, t.score);
      if (t.isActive) row.activeAt = slot;
      bySlot.set(slot, row);
    }
    return Array.from(bySlot.values()).sort((a, b) => (a.at as number) - (b.at as number));
  }, [ticks]);

  const sourceIds = useMemo(() => {
    const s = new Set<string>();
    for (const t of (ticks ?? [])) s.add(t.sourceId);
    return Array.from(s);
  }, [ticks]);

  const isLoadingTicks = !ticks && !!focused?.channelId;

  const colors = ['#15803D', '#2563EB', '#7C3AED', '#D97706', '#E11D48', '#0891B2'];

  return (
    <Card>
      <CardHeader className="flex items-center justify-between flex-row">
        <div>
          <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4 text-brand" /> Failover stats</CardTitle>
          <p className="text-xs text-muted mt-0.5">Per-source score, uptime, and switch counts sampled every 2 seconds.</p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={hours} onValueChange={setHours}>
            <SelectTrigger className="w-28 h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Last 1h</SelectItem>
              <SelectItem value="6">Last 6h</SelectItem>
              <SelectItem value="24">Last 24h</SelectItem>
              <SelectItem value="72">Last 72h</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4">
        {/* Left: per-channel summary list */}
        <ul className="space-y-1 max-h-[360px] overflow-y-auto scrollbar-thin pr-1">
          {(summary ?? []).map((s) => (
            <li key={s.channelId}>
              <button
                onClick={() => setFocusedId(s.channelId)}
                className={cn(
                  'w-full text-left rounded-md border p-2.5 transition-colors',
                  (focused?.channelId === s.channelId) ? 'border-brand/40 bg-brand/5' : 'border-line bg-white hover:border-brand/30',
                )}
              >
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="font-medium truncate">{s.name}</span>
                  <Badge variant={s.uptimePct === null ? 'outline' : s.uptimePct >= 95 ? 'green' : s.uptimePct >= 80 ? 'amber' : 'red'}>
                    {s.uptimePct === null ? 'IDLE' : `${s.uptimePct}%`}
                  </Badge>
                </div>
                <div className="mt-1.5 h-6">
                  {s.sparkline.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={s.sparkline.map((v, i) => ({ i, v }))}>
                        <defs>
                          <linearGradient id={`sp-${s.channelId}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#15803D" stopOpacity="0.7"/>
                            <stop offset="100%" stopColor="#15803D" stopOpacity="0.05"/>
                          </linearGradient>
                        </defs>
                        <Area type="monotone" dataKey="v" stroke="#15803D" strokeWidth={1.2} fill={`url(#sp-${s.channelId})`} isAnimationActive={false} />
                      </AreaChart>
                    </ResponsiveContainer>
                  ) : <div className="h-full bg-panel2/40 rounded" />}
                </div>
                <div className="mt-1 text-[10px] text-muted-2 flex items-center gap-2">
                  <span title="switches"><RefreshCw className="inline h-2.5 w-2.5" /> {s.switches}</span>
                  <span title="avg score"><TrendingUp className="inline h-2.5 w-2.5" /> {s.avgScore !== null ? (s.avgScore * 100).toFixed(0) + '%' : '—'}</span>
                </div>
              </button>
            </li>
          ))}
          {(summary?.length ?? 0) === 0 && <li className="p-4 text-xs text-center text-muted-2">No data yet. Failover controller writes samples every 2s.</li>}
        </ul>

        {/* Right: focused chart */}
        <div className="rounded-md border border-line bg-white p-3 min-h-[300px]">
          {focused ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm font-semibold">{focused.name} <span className="text-muted-2 text-[10px] font-mono ml-1">/{focused.slug}</span></div>
                <Link href={`/channels/${focused.channelId}`} className="text-xs text-brand hover:underline inline-flex items-center gap-1">
                  <Radio className="h-3 w-3" /> Configure sources <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
              <div className="h-64">
                {isLoadingTicks ? (
                  <div className="h-full flex items-center justify-center text-xs text-muted-2">Loading history…</div>
                ) : chartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <XAxis dataKey="at" tickFormatter={(v) => new Date(v as number).toLocaleTimeString().slice(0, 5)} fontSize={10} />
                      <YAxis domain={[0, 1]} tickFormatter={(v) => `${Math.round((v as number) * 100)}%`} fontSize={10} />
                      <Tooltip
                        labelFormatter={(v) => new Date(v as number).toLocaleString()}
                        formatter={(val, name) => [`${(Number(val) * 100).toFixed(0)}%`, `src ${String(name).replace('s_', '').slice(0, 6)}`]}
                        contentStyle={{ fontSize: 11, border: '1px solid rgba(15,23,42,0.1)', borderRadius: 6 }}
                      />
                      <ReferenceLine y={0.5} stroke="#94A3B8" strokeDasharray="3 3" />
                      {sourceIds.map((id, i) => (
                        <Line key={id} type="monotone" dataKey={`s_${id}`}
                          stroke={colors[i % colors.length]} strokeWidth={1.5} dot={false}
                          isAnimationActive={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center gap-1 text-xs text-muted-2">
                    <span>No samples yet for this channel.</span>
                    <span className="text-[10px]">Failover controller writes one tick per source every 2 seconds.</span>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="h-64 flex items-center justify-center text-xs text-muted-2">Pick a channel from the list to see its per-source score history.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
