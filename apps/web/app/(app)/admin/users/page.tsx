'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, UserX, UserCheck, ShieldCheck, PenLine, Info } from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { ROLES, PERMISSION_FEATURES, PERMISSION_ACTIONS, defaultPermissionsForRole } from '@cmc/shared';
import { cn } from '@/lib/utils';

interface User {
  id: string; email: string; name: string;
  role: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';
  roleName: string | null;
  permissions: string[] | null;
  disabledAt: string | null;
  lastLoginAt: string | null;
}

type Role = 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';
interface FormState {
  email: string; name: string; password: string;
  role: Role;
  roleName: string;
  permissions: Set<string>;
}
const emptyForm: FormState = {
  email: '', name: '', password: '',
  role: 'ANALYST',
  roleName: '',
  permissions: new Set<string>(),
};

export default function UsersPage() {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [form, setForm] = useState<FormState>({ ...emptyForm, permissions: new Set() });

  const { data: users } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api<User[]>('/api/users'),
  });

  function openNew() {
    const perms = new Set(defaultPermissionsForRole('ANALYST'));
    setForm({ email: '', name: '', password: '', role: 'ANALYST', roleName: '', permissions: perms });
    setEditing(null);
    setDialogOpen(true);
  }
  function openEdit(u: User) {
    const perms = new Set(u.permissions ?? defaultPermissionsForRole(u.role));
    setForm({ email: u.email, name: u.name, password: '', role: u.role, roleName: u.roleName ?? '', permissions: perms });
    setEditing(u);
    setDialogOpen(true);
  }

  function applyRolePreset(role: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER') {
    setForm((f) => ({ ...f, role, permissions: new Set(defaultPermissionsForRole(role)) }));
  }

  function togglePerm(feature: string, action: string) {
    setForm((f) => {
      const key = `${feature}:${action}`;
      const next = new Set(f.permissions);
      next.has(key) ? next.delete(key) : next.add(key);
      return { ...f, permissions: next };
    });
  }

  const createMut = useMutation({
    mutationFn: () => api('/api/users', { method: 'POST', body: {
      email: form.email, name: form.name, password: form.password,
      role: form.role, roleName: form.roleName || null,
      permissions: Array.from(form.permissions),
    } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setDialogOpen(false); toast.success('User created'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const patchMut = useMutation({
    mutationFn: () => api(`/api/users/${editing!.id}`, { method: 'PATCH', body: {
      name: form.name, role: form.role, roleName: form.roleName || null,
      permissions: Array.from(form.permissions),
      ...(form.password ? { password: form.password } : {}),
    } }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setDialogOpen(false); toast.success('User updated'); },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Failed'),
  });
  const togglePatchMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) => api(`/api/users/${id}`, { method: 'PATCH', body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });

  return (
    <div className="max-w-[1200px] mx-auto space-y-6">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Users</h1>
          <p className="text-xs text-muted mt-0.5">Custom role labels + per-feature access. Every change is audit-logged.</p>
        </div>
        <Button variant="gradient" onClick={openNew}><Plus /> New user</Button>
      </div>

      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
            <tr>
              <th className="text-left px-4 py-2">User</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Permissions</th>
              <th className="text-left px-4 py-2">Last login</th>
              <th className="text-left px-4 py-2">Status</th>
              <th className="px-4 py-2 w-56"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(users ?? []).map((u) => (
              <tr key={u.id} className="hover:bg-panel/40">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 rounded-full bg-g-brand flex items-center justify-center font-bold text-[11px] text-white">
                      {u.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <div className="font-medium">{u.name}</div>
                      <div className="text-xs text-muted">{u.email}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-sm font-medium">{u.roleName || u.role}</span>
                    {u.roleName && <span className="text-[10px] uppercase tracking-widest text-muted-2">preset: {u.role}</span>}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-muted">
                  {(u.permissions ?? defaultPermissionsForRole(u.role)).length} grants
                </td>
                <td className="px-4 py-3 text-xs text-muted">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : '—'}</td>
                <td className="px-4 py-3">
                  {u.disabledAt ? <Badge variant="red">DISABLED</Badge> : <Badge variant="green">ACTIVE</Badge>}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 justify-end">
                    <Button size="sm" variant="secondary" onClick={() => openEdit(u)}><PenLine className="h-3.5 w-3.5" /> Edit</Button>
                    <Button size="sm" variant="secondary" onClick={() => togglePatchMut.mutate({ id: u.id, patch: { disabled: !u.disabledAt } })}>
                      {u.disabledAt ? <><UserCheck className="h-3.5 w-3.5" /></> : <><UserX className="h-3.5 w-3.5" /></>}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(v) => !v && setDialogOpen(false)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto scrollbar-thin">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit user — ${editing.name}` : 'Create user'}</DialogTitle>
            <DialogDescription>Enter a custom role name and tick every feature this user needs.</DialogDescription>
          </DialogHeader>
          <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); editing ? patchMut.mutate() : createMut.mutate(); }}>
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Name</Label><Input required value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></div>
              <div><Label>Email</Label><Input type="email" required disabled={!!editing} value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></div>
              <div>
                <Label>Role name (custom)</Label>
                <Input value={form.roleName} onChange={(e) => setForm((f) => ({ ...f, roleName: e.target.value }))} placeholder="e.g. Newsroom Editor" />
                <p className="text-[10px] text-muted-2 mt-1">Free-text label shown to operators. The preset below is the security fallback.</p>
              </div>
              <div>
                <Label>Preset</Label>
                <Select value={form.role} onValueChange={(v) => applyRolePreset(v as typeof form.role)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>{ROLES.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                </Select>
                <p className="text-[10px] text-muted-2 mt-1">Selecting a preset re-fills the checkboxes with sensible defaults.</p>
              </div>
              <div className="col-span-2">
                <Label>Password {editing && <span className="text-muted-2 normal-case">(leave blank to keep current)</span>}</Label>
                <Input type="password" required={!editing} minLength={8} value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
              </div>
            </div>

            <div className="rounded-lg border border-line bg-panel2/40 p-3">
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck className="h-4 w-4 text-brand" />
                <div className="text-xs font-semibold uppercase tracking-widest text-muted-2">Feature access</div>
                <div className="ml-auto text-[11px] text-muted-2 flex items-center gap-1">
                  <Info className="h-3 w-3" /> {form.permissions.size} grants selected
                </div>
              </div>
              <div className="overflow-x-auto scrollbar-thin">
                <table className="w-full text-xs">
                  <thead className="text-[10px] uppercase tracking-widest text-muted-2">
                    <tr>
                      <th className="text-left px-2 py-1.5 w-56">Feature</th>
                      {PERMISSION_ACTIONS.map((a) => (
                        <th key={a.key} className="text-center px-2 py-1.5 w-24">{a.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {PERMISSION_FEATURES.map((f) => (
                      <tr key={f.key} className="hover:bg-white/40">
                        <td className="px-2 py-1.5">{f.label}</td>
                        {PERMISSION_ACTIONS.map((a) => {
                          const key = `${f.key}:${a.key}`;
                          const on = form.permissions.has(key);
                          return (
                            <td key={a.key} className="text-center px-2 py-1.5">
                              <label className={cn('inline-flex items-center justify-center h-5 w-5 rounded border cursor-pointer transition-colors',
                                on ? 'bg-brand border-brand text-white' : 'border-border bg-white text-transparent hover:border-brand/40')}>
                                <input type="checkbox" checked={on} onChange={() => togglePerm(f.key, a.key)} className="sr-only" />
                                <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M5 12l5 5 9-11"/></svg>
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <DialogFooter>
              <Button type="button" variant="secondary" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button type="submit" variant="gradient" disabled={createMut.isPending || patchMut.isPending}>
                {editing ? 'Save changes' : 'Create user'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
