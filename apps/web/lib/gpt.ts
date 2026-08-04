'use client';

/**
 * SSE reader that authenticates via Authorization: Bearer (which native
 * EventSource cannot do). Yields parsed events with `event` name + `data`.
 */
export interface SseEvent { event: string; data: string }

export async function *streamSse(url: string, init: RequestInit): AsyncGenerator<SseEvent, void, void> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('demp.accessToken') : null;
  const headers = new Headers(init.headers);
  headers.set('Accept', 'text/event-stream');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j?.error ?? j?.message ?? msg; } catch { /* */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('no body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let sep = buf.indexOf('\n\n');
    while (sep !== -1) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf('\n\n');
      const lines = raw.split('\n');
      let event = 'message';
      const dataParts: string[] = [];
      for (const l of lines) {
        if (l.startsWith('event:')) event = l.slice(6).trim();
        else if (l.startsWith('data:')) dataParts.push(l.slice(5).replace(/^ /, ''));
      }
      yield { event, data: dataParts.join('\n') };
    }
  }
}
