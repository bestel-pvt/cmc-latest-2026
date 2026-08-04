import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider',
  {
    variants: {
      variant: {
        default:  'bg-panel2 text-muted border border-border',
        brand:    'bg-brand text-white',
        cyan:     'bg-accent-cyan text-white',
        green:    'bg-accent-green text-white',
        red:      'bg-accent-red text-white',
        purple:   'bg-accent-purple text-white',
        amber:    'bg-accent-amber text-white',
        outline:  'border border-border text-muted',
        live:     'bg-accent-red text-white',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}
export { badgeVariants };
