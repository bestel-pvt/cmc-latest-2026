'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Eye, EyeOff, Loader2, LockKeyhole, Mail } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DempLogo, PoweredByAnalysys } from '@/components/brand-mark';
import { useAuth } from '@/lib/auth';

export default function LoginPage() {
  const router = useRouter();
  const login = useAuth((s) => s.login);
  const [email, setEmail] = useState('admin@cmc.local');
  const [password, setPassword] = useState('cmc-admin-2026');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await login(email, password);
      toast.success('Signed in');
      router.push('/dashboard');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-6 overflow-hidden">
      {/* soft ambient glows */}
      <div className="pointer-events-none absolute -top-32 -right-24 h-96 w-96 rounded-full blur-3xl bg-brand/12" />
      <div className="pointer-events-none absolute bottom-0 -left-24 h-96 w-96 rounded-full blur-3xl bg-accent-blue/8" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center gap-4">
          <DempLogo size={230} />
          <div>
            <div className="text-[10px] uppercase tracking-[0.22em] text-muted-2 font-semibold">
              Government of Pakistan
            </div>
            <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-txt">
              Pakistan Navy
              <br />
              Channel Monitoring &amp; Clipping <span className="text-brand">(CMC)</span>
            </h1>
            <p className="mt-2 text-xs uppercase tracking-[0.22em] text-muted">
              Live Ingest · Recording · Clipping
            </p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="card card-glow p-7 space-y-5">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
              <Input id="email" type="email" autoFocus autoComplete="email" className="pl-9"
                value={email} onChange={(e) => setEmail(e.target.value)} required />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <LockKeyhole className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
              <Input
                id="password"
                type={show ? 'text' : 'password'}
                autoComplete="current-password"
                className="pl-9 pr-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? 'Hide password' : 'Show password'}
                className="absolute right-2.5 top-2 rounded-md p-1 text-muted-2 hover:text-txt hover:bg-panel2 transition-colors"
              >
                {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          <Button type="submit" variant="gradient" size="lg" className="w-full" disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : 'Sign In'}
          </Button>

          <p className="text-[10px] text-muted-2 text-center leading-relaxed">
            Access to this system is monitored. All activity is recorded to an immutable audit log.
          </p>
        </form>

        <div className="mt-6 flex items-center justify-center">
          <PoweredByAnalysys height={44} />
        </div>
      </div>
    </div>
  );
}
