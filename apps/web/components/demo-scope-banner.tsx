'use client';

import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Prominent notice that AI features (recording, tickers, flashers, transcription,
 * alerts, clips) are configured for only two demo channels at the moment. Shown
 * at the top of every page that hosts one of those features.
 */
export function DemoScopeBanner({ className, feature }: { className?: string; feature?: string }) {
  return (
    <div className={cn(
      'flex items-start gap-3 rounded-lg border border-amber-400/40 bg-amber-50/70 px-4 py-3 text-[13px] text-amber-900 shadow-soft',
      className,
    )}>
      <Info className="h-4 w-4 mt-0.5 shrink-0 text-amber-700" />
      <div>
        <span className="font-semibold">Demo scope · {feature ?? 'AI features'}: </span>
        Currently configured for <b>Dunya News</b> only. The desktop video wall, network stream URLs,
        and channel health work for every channel. The remaining channels will be enabled once the
        commercial settlement is agreed.
      </div>
    </div>
  );
}
