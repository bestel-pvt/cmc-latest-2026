'use client';

import { useRouter } from 'next/navigation';
import { Search, Bell, LogOut, User as UserIcon, ChevronDown, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DempFullTitle } from '@/components/brand-mark';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/lib/auth';

export function AppTopbar() {
  const router = useRouter();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  function onLogout() { logout(); router.push('/login'); }

  // Sidebar highlight already tells the operator which page they're on
  // — the breadcrumb row below was redundant. Removed.
  return (
    <header className="flex-none bg-white/85 backdrop-blur z-30 shadow-[0_1px_0_rgba(15,23,42,0.05)]">
      <div className="min-h-[132px] px-6 py-4 flex items-center gap-4 border-b border-line/50">
        <DempFullTitle size={112} />
        <div className="flex-1" />
        <div className="relative w-72 hidden md:block">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
          <Input placeholder="Search channels, clips, tickers…" className="pl-9 pr-14" />
          <kbd className="absolute right-3 top-2 hidden md:inline kbd">⌘K</kbd>
        </div>
        <Button variant="ghost" size="icon" aria-label="Alerts">
          <Bell className="h-4 w-4" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-2">
              <div className="h-7 w-7 rounded-full bg-g-brand flex items-center justify-center text-[11px] font-bold text-white">
                {(user?.name ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="hidden md:block text-left leading-tight">
                <div className="text-xs font-medium">{user?.name ?? '—'}</div>
                <div className="text-[10px] uppercase tracking-widest text-muted-2">{user?.role ?? '—'}</div>
              </div>
              <ChevronDown className="h-3.5 w-3.5 text-muted-2" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>{user?.email}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="cursor-pointer">
              <UserIcon className="h-4 w-4" /> Profile
            </DropdownMenuItem>
            {user?.role === 'ADMIN' && (
              <DropdownMenuItem onClick={() => router.push('/admin/settings')} className="cursor-pointer">
                <ShieldCheck className="h-4 w-4" /> Admin settings
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onLogout} className="cursor-pointer text-accent-red focus:text-accent-red">
              <LogOut className="h-4 w-4" /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
