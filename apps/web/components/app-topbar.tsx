'use client';

/**
 * Top bar — CMC edition. Left: PAK NAVY brand mark + title.
 * Right: Powered-by-Analysys lockup. Nothing else — search, bell,
 * user dropdown were operator noise on a monitoring surface. Logout
 * lives on the sidebar bottom instead so it's one predictable click.
 */

import { DempFullTitle, PoweredByAnalysys } from '@/components/brand-mark';

export function AppTopbar() {
  return (
    <header className="flex-none bg-white/85 backdrop-blur z-30">
      <div className="min-h-[132px] px-6 py-4 flex items-center gap-4 border-b border-line/60">
        <DempFullTitle size={112} />
        <div className="flex-1" />
        <PoweredByAnalysys height={100} />
      </div>
    </header>
  );
}
