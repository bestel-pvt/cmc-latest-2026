// Returns the TRUE PTS duration (ms) of a recorded .mp4 segment —
// the amount of CONTENT inside, NOT the wall-clock span the recorder
// took to write it. First call measures via `ffmpeg -c copy -f null`
// and caches to `<path>.pts`; subsequent calls read the cache.
//
// Why: when a recording ffmpeg spawns (service start, crash recovery,
// age-recycle), its FIRST segment contains 3-5 s of extra
// UDP-buffered content. Observed on 2026-10-20 for cmse7e6mi00011...
//
//   file 20261020T100535Z.mp4
//     wall-clock (mtime - filename) = 56 005 ms
//     TRUE PTS duration             = 61 050 ms   (+5 s)
//   file 20261020T100732Z.mp4 (normal)
//     wall-clock                    = 59 395 ms
//     TRUE PTS duration             = 59 690 ms   (+0.3 s)
//
// All downstream code (session.m3u8 PDT, clipWorker trim math) was
// anchoring on the filename-parsed wall-clock. For first-of-process
// segments that mis-anchored by 3-5 s and clips covering them drifted
// by exactly that amount — the "sometimes 2-3 seconds piche/aage,
// kisi bhi channel pe" symptom reported 2026-10-20.
//
// This helper + getSegmentTruthfulStart replace that anchor with
//   true_first_frame_wall = mtime - ptsMs
// which gives zero-drift clip math across both normal and
// first-of-process segments.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const CACHE_SUFFIX = '.pts';
const MIN_MS = 1000;
const MAX_MS = 900_000;

export async function getSegmentPtsMs(path: string): Promise<number | null> {
  const cachePath = `${path}${CACHE_SUFFIX}`;
  try {
    if (existsSync(cachePath)) {
      const raw = readFileSync(cachePath, 'utf8').trim();
      const ms = Number(raw);
      if (Number.isFinite(ms) && ms >= MIN_MS && ms <= MAX_MS) return ms;
    }
  } catch { /* fall through to measurement */ }

  if (!existsSync(path)) return null;

  const ms = await new Promise<number | null>((resolve) => {
    const ff = spawn('ffmpeg', [
      '-v', 'error', '-stats',
      '-fflags', '+discardcorrupt',
      '-i', path,
      '-c', 'copy', '-f', 'null', '-',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (b) => { stderr += b.toString(); });
    ff.on('error', () => resolve(null));
    ff.on('exit', (code) => {
      if (code !== 0 && code !== 1) return resolve(null);
      const matches = [...stderr.matchAll(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/g)];
      if (matches.length === 0) return resolve(null);
      const last = matches[matches.length - 1]!;
      const h = Number(last[1]); const m = Number(last[2]); const s = Number(last[3]);
      const fracStr = last[4] ?? '0';
      const frac = Number(`0.${fracStr}`);
      const measured = Math.round(((h * 3600 + m * 60 + s) + frac) * 1000);
      if (Number.isFinite(measured) && measured >= MIN_MS && measured <= MAX_MS) return resolve(measured);
      resolve(null);
    });
  });

  if (ms !== null) {
    try { writeFileSync(cachePath, String(ms), 'utf8'); } catch { /* cache best-effort */ }
  }
  return ms;
}

// true_first_frame_wall = mtime - ptsMs. Fallback to filename-parsed
// start keeps old behaviour when ffmpeg or stat fails — no regression.
export async function getSegmentTruthfulStart(path: string, fallbackStart: Date): Promise<Date> {
  try {
    const ptsMs = await getSegmentPtsMs(path);
    if (ptsMs === null) return fallbackStart;
    const mtimeMs = statSync(path).mtimeMs;
    const trueStartMs = Math.round(mtimeMs - ptsMs);
    if (!Number.isFinite(trueStartMs)) return fallbackStart;
    return new Date(trueStartMs);
  } catch {
    return fallbackStart;
  }
}

// Bounded parallel map — spawns at most `limit` ffmpeg probes in
// flight so a 60-segment session.m3u8 doesn't fork 60 processes at
// once on a server already running 60+ record ffmpegs.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers: Promise<void>[] = [];
  const effLimit = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < effLimit; w++) {
    workers.push((async () => {
      while (true) {
        const idx = next++;
        if (idx >= items.length) break;
        results[idx] = await fn(items[idx]!, idx);
      }
    })());
  }
  await Promise.all(workers);
  return results;
}
