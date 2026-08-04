'use client';

import { cn } from '@/lib/utils';

interface Props {
  value: number | null | undefined; // 0..1
  size?: 'sm' | 'md';
  label?: boolean;
  className?: string;
}

export function HealthMeter({ value, size = 'md', label = false, className }: Props) {
  const v = value ?? 0;
  const pct = Math.round(v * 100);
  const color =
    v >= 0.75 ? 'bg-accent-green' :
    v >= 0.50 ? 'bg-accent-amber' :
    v >= 0.25 ? 'bg-brand' :
                'bg-accent-red';
  const dot =
    v >= 0.75 ? 'bg-accent-green shadow-[0_0_10px_rgba(34,199,106,.6)]' :
    v >= 0.50 ? 'bg-accent-amber shadow-[0_0_10px_rgba(255,194,60,.6)]' :
    v >= 0.25 ? 'bg-brand' :
                'bg-accent-red';
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className={cn(size === 'sm' ? 'h-1.5 w-1.5' : 'h-2 w-2', 'rounded-full', dot, value === null && 'opacity-30')} />
      <div className={cn('flex-1 relative overflow-hidden rounded-full bg-panel2/70', size === 'sm' ? 'h-1' : 'h-1.5')}>
        <div className={cn('h-full', color, 'transition-all')} style={{ width: `${pct}%` }} />
      </div>
      {label && (
        <span className="text-[11px] tabular-nums text-muted font-mono w-9 text-right">{value === null ? '—' : `${pct}%`}</span>
      )}
    </div>
  );
}
