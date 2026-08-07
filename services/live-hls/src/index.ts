/**
 * CMC live-hls service.
 *
 * Spawns one ffmpeg per active channel that reads the source stream
 * directly (UDP multicast for satellite feeds, RTSP for backups) and
 * remuxes it to HLS on disk under `HLS_DIR/<slug>/live.m3u8`. Nginx
 * serves the directory at `/hls/`, so a browser hits
 *   http://<host>/hls/<slug>/live.m3u8
 * and hls.js plays it — no MediaMTX, no transcoder pool.
 *
 * `-c copy` means each ffmpeg is ~0.5% of one CPU core (pure remux,
 * no encoding). 32 channels sit comfortably below 20% of ONE core on
 * the 56-core Windows Server; the rest of the box is free for
 * recording + web + API.
 *
 * Supervisor logic:
 *   - polls Postgres every RESCAN_INTERVAL_MS for the active channel
 *     list (so an admin flipping a channel active/inactive takes
 *     effect within 30 s without restarting the service)
 *   - restarts a died ffmpeg with exponential backoff (up to 30 s)
 *   - kills+respawns if the source URL changes
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { prisma } from '@cmc/db';

const log = pino({
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
});

const HLS_DIR             = resolve(process.env.HLS_DIR ?? './data/hls');
const HLS_SEGMENT_TIME    = Number(process.env.HLS_SEGMENT_TIME ?? 2);
const HLS_LIST_SIZE       = Number(process.env.HLS_LIST_SIZE   ?? 5);
const FFMPEG              = process.env.FFMPEG_PATH ?? 'ffmpeg';
const RESCAN_INTERVAL_MS  = Number(process.env.LIVE_HLS_RESCAN_MS ?? 30_000);

interface Sup {
  channelId:      string;
  slug:           string;
  url:            string;
  kind:           string;
  proc:           ChildProcess | null;
  restarts:       number;
  lastRestartAt:  number;
  stop:           boolean;
}

const supervisors = new Map<string, Sup>();

/** Normalise URL: udp:// gets `@` marker + reliability params. */
function normaliseUrl(url: string, kind: string): string {
  let u = url.trim();
  if (kind === 'UDP' || kind === 'RTP') {
    const scheme = kind.toLowerCase();
    // Ensure `@` for listen/multicast mode.
    if (u.toLowerCase().startsWith(`${scheme}://`) && !u.toLowerCase().startsWith(`${scheme}://@`)) {
      u = `${scheme}://@` + u.slice(scheme.length + 3);
    }
    // Attach reliability params if absent.
    if (!u.includes('fifo_size=')) {
      const sep = u.includes('?') ? '&' : '?';
      u = `${u}${sep}fifo_size=1000000&overrun_nonfatal=1&timeout=10000000`;
    }
  }
  return u;
}

function ffArgs(url: string, kind: string, outDir: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    // Input tolerance — ignore corrupt packets, fix bad DTS, always regen PTS.
    '-fflags', '+discardcorrupt+igndts+genpts',
    '-err_detect', 'ignore_err',
    '-f', 'mpegts',
    '-i', normaliseUrl(url, kind),
    // First video + optional first audio; ignore subtitles/data.
    '-map', '0:v:0',
    '-map', '0:a:0?',
    // Remux only — no encoding. HW decoder on wall-side does its own decode.
    '-c', 'copy',
    // HLS muxer
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_TIME),
    '-hls_list_size', String(HLS_LIST_SIZE),
    // delete_segments = remove segments dropped from the playlist tail.
    // append_list     = don't rewrite from scratch each time.
    // omit_endlist    = never emit #EXT-X-ENDLIST (this is a LIVE stream).
    // independent_segments = each segment is decodable on its own (helps
    //                        recovery from packet loss on the wire).
    '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-hls_segment_filename', join(outDir, 'seg_%d.ts'),
    join(outDir, 'live.m3u8'),
  ];
}

function launch(sup: Sup): void {
  if (sup.stop) return;
  const outDir = join(HLS_DIR, sup.slug);
  mkdirSync(outDir, { recursive: true });
  const args = ffArgs(sup.url, sup.kind, outDir);
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  sup.proc = proc;
  sup.lastRestartAt = Date.now();
  log.info({ slug: sup.slug, url: sup.url }, 'ffmpeg started');

  proc.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    // Skip the noisy `size=… time=…` progress lines; keep real warnings.
    if (line && !/^size=/.test(line) && !/^\s*frame=/.test(line)) {
      log.debug({ slug: sup.slug }, line.slice(0, 300));
    }
  });

  proc.on('exit', (code, sig) => {
    sup.proc = null;
    if (sup.stop) return;
    sup.restarts += 1;
    // Exponential backoff, capped at 30 s.
    const wait = Math.min(30_000, 1000 * Math.pow(2, Math.min(sup.restarts, 5)));
    log.warn(
      { slug: sup.slug, code, sig, restarts: sup.restarts, wait },
      'ffmpeg exited, will restart',
    );
    setTimeout(() => launch(sup), wait);
  });
}

async function rescan(): Promise<void> {
  let channels: Array<{ id: string; slug: string; active: boolean; sources: Array<{ url: string; kind: string; isPrimary: boolean; priority: number }> }>;
  try {
    channels = await prisma.channel.findMany({
      where: { active: true },
      include: {
        sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] },
      },
    });
  } catch (err) {
    log.warn({ err }, 'rescan: prisma query failed');
    return;
  }

  const desired = new Map<string, { slug: string; url: string; kind: string }>();
  for (const ch of channels) {
    const primary =
      ch.sources.find((s) => s.isPrimary && ['UDP', 'RTP', 'RTSP'].includes(s.kind))
      ?? ch.sources.find((s) => ['UDP', 'RTP', 'RTSP'].includes(s.kind));
    if (!primary) continue;
    desired.set(ch.id, { slug: ch.slug, url: primary.url, kind: primary.kind });
  }

  // Start new + update changed URLs.
  for (const [id, want] of desired) {
    const cur = supervisors.get(id);
    if (!cur) {
      const sup: Sup = { channelId: id, slug: want.slug, url: want.url, kind: want.kind,
        proc: null, restarts: 0, lastRestartAt: 0, stop: false };
      supervisors.set(id, sup);
      launch(sup);
      continue;
    }
    if (cur.url !== want.url || cur.kind !== want.kind) {
      log.info({ slug: cur.slug, from: cur.url, to: want.url }, 'source changed, respawning');
      cur.url = want.url;
      cur.kind = want.kind;
      cur.restarts = 0;
      if (cur.proc) { try { cur.proc.kill('SIGKILL'); } catch { /* noop */ } }
      // launch() will fire from the exit handler
    }
  }

  // Stop supervisors for channels that went inactive / were removed.
  for (const [id, sup] of supervisors) {
    if (!desired.has(id)) {
      log.info({ slug: sup.slug }, 'channel inactive, stopping ffmpeg');
      sup.stop = true;
      if (sup.proc) { try { sup.proc.kill('SIGKILL'); } catch { /* noop */ } }
      supervisors.delete(id);
    }
  }
}

async function main(): Promise<void> {
  log.info({ HLS_DIR, HLS_SEGMENT_TIME, HLS_LIST_SIZE, FFMPEG }, 'live-hls starting');
  mkdirSync(HLS_DIR, { recursive: true });
  await rescan();
  setInterval(() => {
    rescan().catch((err) => log.error({ err }, 'rescan failed'));
  }, RESCAN_INTERVAL_MS);
  // Keep the event loop alive.
  process.stdin.resume();
}

function shutdown(): void {
  for (const sup of supervisors.values()) {
    sup.stop = true;
    if (sup.proc) { try { sup.proc.kill('SIGKILL'); } catch { /* noop */ } }
  }
  process.exit(0);
}
process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
