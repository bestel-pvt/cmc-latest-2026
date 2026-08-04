'use client';

import { useEffect, useRef, useState } from 'react';

let sock: WebSocket | null = null;
const listeners = new Set<(m: unknown) => void>();
let reconnectAt: number | null = null;
const pendingSubs = new Set<string>();
let allSubbed = false;

function url(): string {
  if (typeof window === 'undefined') return '';
  return process.env.NEXT_PUBLIC_WS_URL || `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
}

function connect() {
  if (typeof window === 'undefined') return;
  if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
  try { sock = new WebSocket(url()); } catch { return; }

  sock.onopen = () => {
    if (allSubbed) sock?.send(JSON.stringify({ type: 'sub-all' }));
    for (const id of pendingSubs) sock?.send(JSON.stringify({ type: 'sub', channelId: id }));
  };
  sock.onmessage = (e) => {
    try { const m = JSON.parse(String(e.data)); listeners.forEach((l) => l(m)); }
    catch { /* ignore */ }
  };
  sock.onclose = () => {
    sock = null;
    if (reconnectAt) return;
    reconnectAt = window.setTimeout(() => { reconnectAt = null; connect(); }, 2000) as unknown as number;
  };
  sock.onerror = () => { try { sock?.close(); } catch { /* */ } };
}

function safeSend(payload: unknown) {
  if (sock && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(payload));
  else { connect(); /* queued in pendingSubs for on-open */ }
}

export function wsSubscribe(channelId: string) {
  pendingSubs.add(channelId);
  safeSend({ type: 'sub', channelId });
}
export function wsUnsubscribe(channelId: string) {
  pendingSubs.delete(channelId);
  safeSend({ type: 'unsub', channelId });
}
export function wsSubscribeAll() {
  allSubbed = true;
  safeSend({ type: 'sub-all' });
}
export function wsAddListener(l: (m: unknown) => void) {
  connect();
  listeners.add(l);
  return () => { listeners.delete(l); };
}

/** React hook for a stream of typed events. Filter is `is`-narrowing. */
export function useWsEvents<T = unknown>(filter?: (m: unknown) => m is T) {
  const [events, setEvents] = useState<T[]>([]);
  const ref = useRef<T[]>([]);
  useEffect(() => {
    connect();
    const l = (m: unknown) => {
      if (!filter || filter(m)) {
        ref.current = [...ref.current.slice(-199), m as T];
        setEvents(ref.current);
      }
    };
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, [filter]);
  return events;
}
