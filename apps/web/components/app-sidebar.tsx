'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard, Tv2, Film, ScrollText,
  Users, Settings2, Scissors, Shield, Download,
} from 'lucide-react';
import { WordMark, PoweredByAnalysys } from '@/components/brand-mark';
import { cn } from '@/lib/utils';
import { useAuth } from '@/lib/auth';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  roles?: Array<'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER'>;
  section?: string;
}

// CMC (PAK NAVY) — trimmed navigation. No AI features, no failover
// controls. Simple channels + recordings + clips + admin.
const NAV: NavItem[] = [
  { href: '/dashboard',   label: 'Dashboard',   icon: LayoutDashboard },
  { href: '/channels',    label: 'Channels',    icon: Tv2 },
  { href: '/recordings',  label: 'Recordings',  icon: Film },
  { href: '/clips',       label: 'Clips',       icon: Scissors },
  { href: '/downloads',   label: 'Downloads',   icon: Download },

  { section: 'Admin', href: '/admin/users',     label: 'Users',       icon: Users,      roles: ['ADMIN'] },
  { href: '/admin/audit',                       label: 'Audit Log',   icon: ScrollText, roles: ['ADMIN'] },
  { href: '/admin/legal-holds',                 label: 'Legal Holds', icon: Shield,     roles: ['ADMIN','OPERATOR'] },
  { href: '/admin/settings',                    label: 'Settings',    icon: Settings2,  roles: ['ADMIN'] },
];

export function AppSidebar() {
  const pathname = usePathname();
  const user = useAuth((s) => s.user);
  const role = user?.role ?? 'VIEWER';

  return (
    <aside className="hidden lg:flex flex-col w-64 shrink-0 border-r border-line bg-white/70 backdrop-blur h-screen sticky top-0 z-40">
      <div className="h-16 px-5 flex items-center border-b border-line">
        <Link href="/dashboard"><WordMark /></Link>
      </div>

      <nav className="flex-1 overflow-y-auto scrollbar-thin py-4 px-3 space-y-0.5">
        {NAV.map((item, idx) => {
          if (item.roles && !item.roles.includes(role)) return null;
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          const isSectionStart = !!item.section;
          const Icon = item.icon;
          return (
            <div key={item.href}>
              {isSectionStart && (
                <div className="mt-6 mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-2">
                  {item.section}
                </div>
              )}
              <Link
                href={item.href}
                className={cn(
                  'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                  active
                    ? 'bg-brand/10 text-txt ring-1 ring-brand/30 shadow-soft'
                    : 'text-muted hover:text-txt hover:bg-panel2',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', active ? 'text-brand' : 'text-muted-2 group-hover:text-txt')} />
                <span className="truncate">{item.label}</span>
                {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand shadow-glow" />}
              </Link>
              {idx === 0 && <div className="my-3 h-px bg-line mx-1" />}
            </div>
          );
        })}
      </nav>

      <div className="px-4 py-4 border-t border-line flex justify-center">
        <PoweredByAnalysys height={30} />
      </div>
    </aside>
  );
}
