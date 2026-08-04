import Image from 'next/image';
import { cn } from '@/lib/utils';

/**
 * Pakistan Navy crest — the only brand mark across the CMC UI.
 * Sourced from the official Wikimedia SVG (WebP for size).
 */
export function NavyCrest({ className, size = 40 }: { className?: string; size?: number }) {
  return (
    <Image
      src="/brand/pak-navy-emblem.webp"
      alt="Pakistan Navy"
      width={size}
      // Emblem aspect ~ 2000×2450, kept square-ish
      height={Math.round(size * 2450 / 2000)}
      className={cn('shrink-0 select-none', className)}
      priority
    />
  );
}

/** Back-compat re-export so any surviving `DempLogo` import keeps building. */
export const DempLogo = NavyCrest;

/** Compact sidebar wordmark: crest + PAK NAVY label. */
export function WordMark({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center gap-2.5 select-none', className)}>
      <NavyCrest size={36} />
      <div className="leading-tight">
        <div className="font-display font-bold text-base tracking-tight text-txt">PAK NAVY</div>
        <div className="text-[9px] uppercase tracking-[0.16em] text-muted font-medium">
          Channel Monitoring &amp; Clipping
        </div>
      </div>
    </div>
  );
}

/** Full title with crest — used in the top bar. */
export function DempFullTitle({ className, size = 40 }: { className?: string; size?: number }) {
  const isLarge = size >= 90;
  return (
    <div className={cn('flex items-center gap-4 select-none', className)}>
      <NavyCrest size={size} />
      <div className="leading-tight">
        <div
          className={cn(
            'font-semibold uppercase tracking-[0.20em] text-muted-2',
            isLarge ? 'text-sm' : 'text-[10px]',
          )}
        >
          Government of Pakistan
        </div>
        <div
          className={cn(
            'font-display font-bold text-txt tracking-tight',
            isLarge ? 'text-[26px] leading-[1.15] mt-1' : 'text-[13px] mt-0.5',
          )}
        >
          Pakistan Navy
          <span className={cn('ml-2 text-brand font-semibold', isLarge ? '' : 'font-normal')}>
            (CMC)
          </span>
        </div>
        {isLarge && (
          <div className="mt-1.5 text-[11px] uppercase tracking-[0.22em] text-muted font-medium">
            Channel Monitoring &amp; Clipping
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Analysys small icon — used inline in "Powered by" placements.
 */
export function AnalysysLogo({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <Image
      src="/brand/analysys-logo.png"
      alt="Analysys"
      width={size}
      height={size}
      className={cn('shrink-0 select-none', className)}
    />
  );
}

/**
 * "Powered by Analysys" — official supplied lockup, unchanged from DEMP.
 * Operator wants it kept as-is on CMC too.
 */
export function PoweredByAnalysys({ className, height = 36 }: { className?: string; height?: number }) {
  const width = Math.round(height * 706 / 260);
  return (
    <a
      href="https://analysys.tech"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Powered by Analysys"
      className={cn('inline-flex items-center select-none', className)}
    >
      <Image
        src="/brand/powered-by-analysys.png"
        alt="Powered by Analysys"
        width={width}
        height={height}
        style={{ height, width: 'auto' }}
        priority
      />
    </a>
  );
}

/** Standalone clickable "Analysys" wordmark for inline references. */
export function AnalysysLink({ className }: { className?: string }) {
  return (
    <a
      href="https://analysys.tech"
      target="_blank"
      rel="noopener noreferrer"
      className={cn('font-semibold text-brand hover:underline underline-offset-2', className)}
    >
      Analysys
    </a>
  );
}
