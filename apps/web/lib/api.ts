'use client';

const BASE = ''; // next.config rewrites /api → API_URL

type Opts = Omit<RequestInit, 'body'> & { body?: unknown };

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('demp.accessToken');
}

export async function api<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const token = getToken();
  const headers: HeadersInit = {
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(opts.headers as Record<string, string> | undefined),
  };
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'omit',
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      // Prefer human `message` over machine `error` code.
      msg = (j?.message ?? j?.error ?? msg) as string;
    } catch { /* keep default */ }
    if (res.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem('demp.accessToken');
      if (!path.startsWith('/api/auth/')) window.location.href = '/login';
    }
    throw new Error(msg);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
