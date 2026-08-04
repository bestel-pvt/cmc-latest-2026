'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Filter, Search, ScrollText } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api';

interface AuditRow {
  id: string; action: string; entityType: string | null; entityId: string | null;
  createdAt: string; ip: string | null;
  user: { id: string; name: string; email: string } | null;
  meta: Record<string, unknown> | null;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const { data: rows } = useQuery<AuditRow[]>({
    queryKey: ['audit', action],
    queryFn: () => {
      const p = new URLSearchParams();
      if (action) p.set('action', action);
      p.set('limit', '200');
      return api<AuditRow[]>(`/api/audit?${p}`);
    },
    refetchInterval: 15_000,
  });

  return (
    <div className="max-w-[1400px] mx-auto space-y-6">
      <div>
        <h1 className="font-display text-2xl font-bold tracking-tight">Audit Log</h1>
        <p className="text-xs text-muted mt-0.5">Append-only record of every mutating action.</p>
      </div>

      <Card className="p-4">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-2" />
          <Input placeholder="Filter by action (e.g., channel.create)" className="pl-9" value={action} onChange={(e) => setAction(e.target.value)} />
        </div>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between flex-row">
          <CardTitle>{(rows?.length ?? 0)} entries</CardTitle>
          <Filter className="h-3.5 w-3.5 text-muted-2" />
        </CardHeader>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="bg-panel2/50 text-[10px] uppercase tracking-widest text-muted-2">
              <tr>
                <th className="text-left px-4 py-2">Time</th>
                <th className="text-left px-4 py-2">Actor</th>
                <th className="text-left px-4 py-2">Action</th>
                <th className="text-left px-4 py-2">Entity</th>
                <th className="text-left px-4 py-2">IP</th>
                <th className="text-left px-4 py-2">Meta</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {(rows ?? []).map((r) => (
                <tr key={r.id} className="hover:bg-panel/40 align-top">
                  <td className="px-4 py-2 font-mono text-[11px] whitespace-nowrap">{new Date(r.createdAt).toISOString().replace('T',' ').slice(0,19)}</td>
                  <td className="px-4 py-2 text-xs">{r.user?.email ?? <span className="text-muted-2">system</span>}</td>
                  <td className="px-4 py-2"><Badge variant="outline" className="font-mono">{r.action}</Badge></td>
                  <td className="px-4 py-2 text-xs">
                    {r.entityType && <><span className="text-muted">{r.entityType}</span> · <span className="font-mono text-muted-2">{r.entityId?.slice(0, 10)}…</span></>}
                  </td>
                  <td className="px-4 py-2 font-mono text-[11px] text-muted-2">{r.ip}</td>
                  <td className="px-4 py-2 font-mono text-[10px] text-muted-2 max-w-md truncate">{r.meta ? JSON.stringify(r.meta) : ''}</td>
                </tr>
              ))}
              {(rows?.length ?? 0) === 0 && (
                <tr><td colSpan={6} className="p-10 text-center text-sm text-muted"><ScrollText className="h-8 w-8 mx-auto mb-3 text-muted-2" />No audit entries yet.</td></tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
