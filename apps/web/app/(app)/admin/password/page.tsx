'use client';

/**
 * Change Password — sole survivor of the old Settings screen. CMC has
 * no operator-configurable knobs beyond credentials, so retention /
 * AI-model / compliance controls were all removed. Any future operator
 * config lives on its own dedicated page, not in a "Settings" grab-bag.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Loader2 } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '@/lib/api';

export default function ChangePasswordPage() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const changeMut = useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api('/api/auth/change-password', { method: 'POST', body }),
    onSuccess: () => {
      toast.success('Password changed');
      setCurrent(''); setNext(''); setConfirm('');
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Change failed'),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirm) { toast.error('New passwords do not match'); return; }
    if (next.length < 8)  { toast.error('New password must be at least 8 characters'); return; }
    changeMut.mutate({ currentPassword: current, newPassword: next });
  }

  return (
    <div className="max-w-md mx-auto">
      <div className="mb-4">
        <h1 className="font-display text-2xl font-bold tracking-tight">Change Password</h1>
        <p className="text-xs text-muted mt-0.5">Update your login password. All changes are audit-logged.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-brand" /> Password</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Current password</Label>
              <Input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>New password</Label>
              <Input type="password" autoComplete="new-password" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
              <p className="text-[11px] text-muted-2">Minimum 8 characters.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Confirm new password</Label>
              <Input type="password" autoComplete="new-password" required minLength={8} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <div className="pt-2">
              <Button type="submit" variant="gradient" disabled={changeMut.isPending} className="w-full">
                {changeMut.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                Change password
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
