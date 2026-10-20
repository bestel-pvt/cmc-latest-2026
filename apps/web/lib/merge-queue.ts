// Client-side cart for the multi-clip merge builder.
//
// Operators add N {channel, startAt, endAt, labelHint} items from the
// single-clip editor; the /clip-merges/new page reads this queue, lets
// them reorder/remove, and submits as one ClipMerge. Lives in
// localStorage so it survives page reloads but stays per-browser —
// which matches operator workflow (one person, one session).

const KEY = 'cmc.mergeQueue.v1';
const MAX = 30;

export interface MergeQueueItem {
  // stable client-generated id so React keys don't collide
  cid: string;
  channelId: string;
  channelName: string;
  startAt: string;   // ISO
  endAt: string;     // ISO
  // human-readable context — not sent to server, display only
  labelHint?: string;
}

export function readQueue(): MergeQueueItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is MergeQueueItem =>
      !!x && typeof x.cid === 'string' && typeof x.channelId === 'string'
      && typeof x.startAt === 'string' && typeof x.endAt === 'string');
  } catch { return []; }
}

export function writeQueue(items: MergeQueueItem[]): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX))); } catch { /* storage full */ }
}

export function pushToQueue(item: Omit<MergeQueueItem, 'cid'>): MergeQueueItem[] {
  const q = readQueue();
  const cid = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  q.push({ cid, ...item });
  writeQueue(q);
  return q;
}

export function removeFromQueue(cid: string): MergeQueueItem[] {
  const q = readQueue().filter((x) => x.cid !== cid);
  writeQueue(q);
  return q;
}

export function moveInQueue(cid: string, direction: 'up' | 'down'): MergeQueueItem[] {
  const q = readQueue();
  const idx = q.findIndex((x) => x.cid === cid);
  if (idx < 0) return q;
  const target = direction === 'up' ? idx - 1 : idx + 1;
  if (target < 0 || target >= q.length) return q;
  [q[idx], q[target]] = [q[target]!, q[idx]!];
  writeQueue(q);
  return q;
}

export function clearQueue(): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.removeItem(KEY); } catch { /* */ }
}

export const MAX_QUEUE = MAX;
