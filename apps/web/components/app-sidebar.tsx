'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard, Tv2, Film, ScrollText,
  Users, Scissors, LayoutGrid, Image as ImageIcon, KeyRound, LogOut, Layers,
} from 'lucide-react';
import { WordMark } from '@/components/brand-mark';
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
  { href: '/dashboard',   label: 'Dashboard',    icon: LayoutDashboard },
  { href: '/multiviewer', label: 'Video Wall',   icon: LayoutGrid },
  { href: '/channels',    label: 'Channels',     icon: Tv2 },
  { href: '/recordings',  label: 'Recordings',   icon: Film },
  { href: '/clips',       label: 'Clips',        icon: Scissors },
  { href: '/clip-merges', label: 'Merged Clips', icon: Layers },
  { href: '/frames',      label: 'Frames',       icon: ImageIcon },

  { section: 'Admin', href: '/admin/users',     label: 'Users',           icon: Users,      roles: ['ADMIN'] },
  { href: '/admin/audit',                       label: 'Audit Log',       icon: ScrollText, roles: ['ADMIN'] },
  { href: '/admin/password',                    label: 'Change Password', icon: KeyRound },
];

export function AppSidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);
  const role = user?.role ?? 'VIEWER';

  function onLogout() { logout(); router.push('/login'); }

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

      {/* Signed-in user card + logout. Powered-by-Analysys lives on the
          top bar now (bigger, corporate-visible surface); this slot is
          for the operator's own controls. */}
      <div className="px-3 py-3 border-t border-line space-y-2">
        {user ? (
          <div className="px-2 py-1.5 text-xs">
            <div className="font-medium truncate">{user.name}</div>
            <div className="text-[10px] uppercase tracking-widest text-muted-2">{user.role}</div>
          </div>
        ) : null}
        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-accent-red hover:bg-accent-red/10 transition-colors"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}
