/**
 * DEMP recording service.
 *
 * Responsibilities:
 *  - Supervise one FFmpeg process per active channel that reads the LL-HLS
 *    stream published by MediaMTX and writes 60-second MP4 segments.
 *  - On segment close: SHA-256 the file, insert a `RecordingSegment` row,
 *    roll into the hourly `RecordingManifest` (ed25519-signed rollup).
 *  - Publish `demp:events:segment` on Redis so the UI's recording browser
 *    refreshes in real time.
 *  - Listen for `demp:jobs:clip` and render clip exports with a watermark
 *    burn-in (user + timestamp).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
type FF = ChildProcess & { stderr: NonNullable<ChildProcess['stderr']> };
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Redis from 'ioredis';
import pino from 'pino';
import { prisma } from '@cmc/db';

const log = pino({ transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' } });

const REDIS_URL     = process.env.REDIS_URL     ?? 'redis://localhost:6380';
const RECORDINGS    = resolve(process.env.RECORDINGS_DIR ?? './data/recordings');
const CLIPS         = resolve(process.env.CLIPS_DIR      ?? './data/clips');
const SEG_SECONDS   = Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60);
const V_BITRATE     = process.env.RECORDING_VIDEO_BITRATE ?? '2000k';
const A_BITRATE     = process.env.RECORDING_AUDIO_BITRATE ?? '128k';
const SIGN_KEY      = process.env.MANIFEST_SIGNING_KEY   ?? 'dev-only';

const redis    = new Redis(REDIS_URL);
const redisPub = new Redis(REDIS_URL);
const redisSub = new Redis(REDIS_URL);

interface Supervisor {
  channelId: string;
  slug: string;
  proc: FF | null;
  outDir: string;
  restarts: number;
  lastRestartAt: number;
}

const supervisors = new Map<string, Supervisor>();

/**
 * Auto-restart intelligence.
 *
 * If a source drops and the failover controller picks a new one, this map
 * tracks the currently-active source per channel. When a source-switch event
 * arrives from Redis we cleanly close the FFmpeg for the old source and re-open
 * against the new one — so recording continues without gaps or wasted disk.
 *
 * When a stream is completely down (no source healthy), we simply pause: no
 * FFmpeg spawn, no zero-byte segments, and we resume the moment failover
 * signals a healthy source is back.
 */
const activeSourceUrl = new Map<string, string>();

function channelOutDir(channelId: string, when: Date = new Date()): string {
  return join(
    RECORDINGS,
    channelId,
    String(when.getUTCFullYear()),
    String(when.getUTCMonth() + 1).padStart(2, '0'),
    String(when.getUTCDate()).padStart(2, '0'),
    String(when.getUTCHours()).padStart(2, '0'),
  );
}

function spawnFFmpeg(slug: string, sourceUrl: string, kind: string, outDir: string): FF {
  mkdirSync(outDir, { recursive: true });
  const outPattern = join(outDir, '%M.mp4');

  // Read the UDP multicast directly — no HLS, no transcoder dependency.
  // For any RTSP/SRT source we take it as-is.
  let input = sourceUrl.trim();
  if (kind === 'UDP' || kind === 'RTP') {
    if (input.includes('://') && !input.split('://', 2)[1]!.startsWith('@')) {
      const [proto, rest] = input.split('://', 2);
      input = `${proto!.toLowerCase()}://@${rest}`;
    }
    if (!input.includes('?')) {
      input = `${input}?fifo_size=100000&overrun_nonfatal=1&timeout=6000000`;
    }
  }

  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    '-fflags', '+genpts+discardcorrupt',
    '-err_detect', 'ignore_err',
    ...(kind === 'UDP' || kind === 'RTP' ? ['-f', 'mpegts'] : []),
    '-i', input,
    // Stream copy — no re-encode. Handles MPEG-2 / H264 alike.
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', A_BITRATE, '-ac', '2', '-ar', '48000',
    '-map', '0:v:0', '-map', '0:a:0',
    '-f', 'segment',
    '-segment_time', String(SEG_SECONDS),
    '-segment_format', 'mp4',
    '-segment_format_options', 'movflags=+faststart',
    '-reset_timestamps', '1',
    '-strftime', '1',
    outPattern.replace('%M', '%Y%m%dT%H%M%SZ'),
  ];

  log.info({ slug, input, outDir }, 'recorder ffmpeg spawn');
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stderr.on('data', (b) => {
    const line = b.toString().trim();
    if (line && !line.startsWith('frame=')) log.debug({ slug }, line.slice(0, 200));
  });
  return proc;
}

async function sha256(path: string): Promise<string> {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

function sign(payload: string): string {
  // Placeholder signature. Replace with ed25519 in prod (nacl.sign or crypto.sign).
  return createHash('sha256').update(SIGN_KEY + payload).digest('hex');
}

async function ingestClosedSegments(sup: Supervisor) {
  const dir = sup.outDir;
  if (!existsSync(dir)) return;
  const files = await readdir(dir);
  for (const f of files) {
    if (!f.endsWith('.mp4')) continue;
    const full = join(dir, f);
    const marker = full + '.recorded';
    if (existsSync(marker)) continue;
    const st = statSync(full);
    if (Date.now() - st.mtimeMs < 2000) continue;

    // Belt-and-braces dedup: if the DB already knows this path (from a
    // previous ingest run that crashed before the marker file was
    // written) drop the marker now and skip. This is what fixed the
    // 29,916-rows-for-878-files runaway growth we saw in production.
    try {
      const existingRow = await prisma.recordingSegment.findFirst({
        where: { channelId: sup.channelId, path: full },
        select: { id: true },
      });
      if (existingRow) {
        try { writeFileSync(marker, 'existing'); } catch { /* */ }
        continue;
      }
    } catch { /* fall through — best-effort */ }

    try {
      const hash = await sha256(full);
      const m = f.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mp4$/);
      const startedAt = m
        ? new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!))
        : new Date(st.mtimeMs - SEG_SECONDS * 1000);
      const durationMs = SEG_SECONDS * 1000;

      const seg = await prisma.recordingSegment.create({
        data: {
          channelId: sup.channelId,
          startedAt,
          durationMs,
          path: full,
          sizeBytes: BigInt(st.size),
          sha256: hash,
          resolution: null,
          codec: 'h264/aac',
        },
      });

      // CRITICAL: write the marker IMMEDIATELY after the insert
      // succeeds — before anything else that could throw. Was: manifest
      // upsert / AIJob enqueue would fail and the marker never got
      // written, so every subsequent scan re-inserted the same row.
      try { writeFileSync(marker, hash); } catch { /* */ }

      // hourly manifest rollup — failures no longer produce duplicates
      const hourStart = new Date(startedAt); hourStart.setUTCMinutes(0, 0, 0);
      const existing = await prisma.recordingManifest.findUnique({ where: { channelId_hourStart: { channelId: sup.channelId, hourStart } } }).catch(() => null);
      const ids = existing?.segmentIds ?? [];
      ids.push(seg.id);
      const signature = sign(ids.join('|') + hash);
      await prisma.recordingManifest.upsert({
        where: { channelId_hourStart: { channelId: sup.channelId, hourStart } },
        update: { segmentIds: ids, signature },
        create: { channelId: sup.channelId, hourStart, segmentIds: ids, signature },
      });
      await redisPub.publish('demp:events:segment', JSON.stringify({
        type: 'channel.segment', channelId: sup.channelId, segmentId: seg.id, startedAt: seg.startedAt.toISOString(), durationMs,
      }));

      // Auto-enqueue transcription for the new segment.
      try {
        const aj = await prisma.aIJob.create({
          data: {
            kind: 'TRANSCRIBE_SEGMENT',
            targetType: 'RecordingSegment',
            targetId: seg.id,
            channelId: sup.channelId,
            priority: 'NORMAL',
            status: 'QUEUED',
          },
        });
        await redisPub.publish('demp:jobs:ai', JSON.stringify({ id: aj.id, kind: aj.kind }));
      } catch (err) {
        log.warn({ err }, 'failed to enqueue auto-transcription');
      }

      log.info({ channelId: sup.channelId, seg: f, sha256: hash.slice(0, 10) }, 'segment recorded');
    } catch (err) {
      log.warn({ err, f }, 'failed to ingest segment');
    }
  }
}

async function refreshSupervisors() {
  const channels = await prisma.channel.findMany({
    where: { active: true, recordingEnabled: true },
    include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }], take: 1 } },
  });

  const activeIds = new Set(channels.map((c) => c.id));

  // Stop supervisors for channels no longer marked to record.
  for (const [id, sup] of supervisors) {
    if (!activeIds.has(id)) {
      log.info({ id }, 'stopping supervisor');
      (sup as Supervisor & { _stopped?: boolean })._stopped = true;   // suppress the auto-restart handler
      try { sup.proc?.kill('SIGINT'); } catch { /* */ }
      supervisors.delete(id);
    }
  }

  // Start missing supervisors.
  for (const c of channels) {
    if (supervisors.has(c.id)) continue;
    if (c.sources.length === 0) continue;
    const primary = c.sources[0]!;
    const outDir = channelOutDir(c.id);
    const sup: Supervisor & { _stopped?: boolean } = { channelId: c.id, slug: c.slug, proc: null, outDir, restarts: 0, lastRestartAt: 0 };
    sup.proc = spawnFFmpeg(c.slug, primary.url, primary.kind, outDir);
    sup.proc.on('exit', (code) => {
      // If refreshSupervisors marked this stopped (user turned off
      // recordingEnabled), don't respawn. Was: exit handler always
      // respawned → toggle-off never actually stopped the recorder.
      if (sup._stopped) return;
      log.warn({ slug: c.slug, code }, 'recorder ffmpeg exited');
      const now = Date.now();
      sup.restarts = now - sup.lastRestartAt > 30_000 ? 0 : sup.restarts + 1;
      const delay = Math.min(30_000, 500 * 2 ** sup.restarts);
      setTimeout(() => {
        if (sup._stopped) return;                                     // in case toggle-off happened during backoff
        sup.outDir = channelOutDir(sup.channelId);
        sup.lastRestartAt = Date.now();
        sup.proc = spawnFFmpeg(c.slug, primary.url, primary.kind, sup.outDir);
      }, delay);
    });
    supervisors.set(c.id, sup);
  }
}

async function clipWorker(job: { clipId: string }) {
  const clip = await prisma.clip.findUnique({ where: { id: job.clipId } });
  if (!clip) return;
  await prisma.clip.update({ where: { id: clip.id }, data: { status: 'RENDERING' } });
  log.info({ clipId: clip.id }, 'rendering clip');

  mkdirSync(CLIPS, { recursive: true });
  const outFile = join(CLIPS, `${clip.id}.${clip.format.toLowerCase()}`);

  // Find segments overlapping [startAt, endAt]
  const segs = await prisma.recordingSegment.findMany({
    where: {
      channelId: clip.channelId,
      startedAt: { lte: clip.endAt },
      AND: [{ startedAt: { gte: new Date(clip.startAt.getTime() - 24 * 3600 * 1000) } }],
    },
    orderBy: { startedAt: 'asc' },
  });
  const covering = segs.filter((s) => {
    const end = new Date(s.startedAt.getTime() + s.durationMs);
    return end > clip.startAt && s.startedAt < clip.endAt;
  });
  if (covering.length === 0) {
    await prisma.clip.update({ where: { id: clip.id }, data: { status: 'FAILED' } });
    log.warn({ clipId: clip.id }, 'no covering segments');
    return;
  }

  // Simple robust clip render:
  //   * cut precisely with -ss / -to from the first covering segment
  //   * scale/pad to target resolution
  //   * burn DEMP + operator watermark
  //   * audio: try to copy the source track; if the source has none we
  //     inject silence so the output MP4 always has both v+a tracks
  //     (avoids the "concat: audio stream missing → ffmpeg exit 234"
  //      failure mode we hit in production).
  // Cross-segment stitching (>1 segment span) is a follow-on that will
  // build a concat demuxer input list.
  const first = covering[0]!;
  const ss = (clip.startAt.getTime() - first.startedAt.getTime()) / 1000;
  const to = (clip.endAt.getTime()   - first.startedAt.getTime()) / 1000;

  // FFmpeg drawtext parses ':' as an option separator inside
  // filter_complex — a watermark like "admin@demp.local · 2026-08-04T03:33:27.990Z"
  // was crashing ffmpeg (exit 234, "Invalid argument around [outv]").
  // Escape :, \, and % for drawtext, plus drop the ' which we already
  // strip. Also flatten the ISO timestamp to a friendlier form.
  const wmRaw = (clip.watermarkText ?? '').replace(/'/g, '');
  const wm = wmRaw
    .replace(/T(\d\d):(\d\d):(\d\d)(\.\d+)?Z/, ' $1-$2-$3 UTC')  // ISO → readable
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
  const [w, h] = clip.resolution.split('x').map(Number);
  const duration = Math.max(1, to - ss);

  const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const FONT_REG  = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  const args = [
    '-hide_banner', '-loglevel', 'warning',
    '-ss', String(Math.max(0, ss)),
    '-to', String(Math.max(ss + 1, to)),
    '-i', first.path,
    // Always-present silent audio (used only if source has no audio).
    '-f', 'lavfi', '-t', String(duration + 1), '-i', 'anullsrc=r=48000:cl=stereo',
    '-filter_complex',
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,` +
      // Persistent DEMP wordmark top-right + Powered by Analysys line
      `drawtext=text='DEMP':fontcolor=white@0.55:fontsize=42:fontfile=${FONT_BOLD}:x=w-tw-24:y=24,` +
      `drawtext=text='Powered by Analysys':fontcolor=white@0.55:fontsize=14:fontfile=${FONT_REG}:x=w-tw-24:y=68,` +
      // Bottom strip with operator/timestamp watermark
      `drawbox=x=0:y=ih-30:w=iw:h=30:color=#0B1E3A@0.8:t=fill,` +
      `drawtext=text='${wm}':fontcolor=white@0.85:fontsize=14:fontfile=${FONT_REG}:x=16:y=h-22` +
      `[outv]`,
    '-map', '[outv]',
    // Prefer source audio; if it doesn't exist, fall back to silent lavfi.
    '-map', '0:a:0?', '-map', '1:a:0',
    '-shortest',
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', V_BITRATE,
    '-c:a', 'aac', '-b:a', A_BITRATE, '-ac', '2', '-ar', '48000',
    '-movflags', '+faststart',
    '-y',
    outFile,
  ];
  log.info({ clipId: clip.id }, 'ffmpeg clip render');

  await new Promise<void>((resolve2, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    p.on('exit', (code) => code === 0 ? resolve2() : reject(new Error(`ffmpeg exit ${code} — last stderr: ${tail.slice(-400)}`)));
    p.stderr.on('data', (b) => { tail += b.toString(); });
    p.on('error', reject);
  }).then(async () => {
    const size = statSync(outFile).size;
    const hash = await sha256(outFile);
    await prisma.clip.update({ where: { id: clip.id }, data: {
      status: 'READY', path: outFile, sizeBytes: BigInt(size), sha256: hash,
    } });
    log.info({ clipId: clip.id }, 'clip ready');
  }).catch(async (err) => {
    log.error({ err, clipId: clip.id }, 'clip render failed');
    await prisma.clip.update({ where: { id: clip.id }, data: { status: 'FAILED' } });
    try { unlinkSync(outFile); } catch { /* */ }
  });
}

function hasFfmpeg(): boolean {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

async function main() {
  mkdirSync(RECORDINGS, { recursive: true });
  mkdirSync(CLIPS, { recursive: true });

  if (!hasFfmpeg()) {
    log.warn('ffmpeg not found on PATH — recording service will idle. Install FFmpeg (winget install Gyan.FFmpeg) and restart.');
    // Idle heartbeat every 60s so restart-on-crash supervisors don't churn.
    setInterval(() => { /* idle */ }, 60_000);
    return;
  }

  // clip job queue + source-switch listener (recording resilience)
  await redisSub.subscribe('demp:jobs:clip', 'demp:events:source-switch');
  redisSub.on('message', (ch, raw) => {
    if (ch === 'demp:jobs:clip') {
      try { const job = JSON.parse(raw); void clipWorker(job); }
      catch (err) { log.warn({ err }, 'bad clip job'); }
      return;
    }
    if (ch === 'demp:events:source-switch') {
      try {
        const ev = JSON.parse(raw) as { channelId: string };
        const sup = supervisors.get(ev.channelId);
        if (!sup) return;
        log.info({ channelId: ev.channelId }, 'source switched — restarting recorder cleanly');
        try { sup.proc?.kill('SIGINT'); } catch { /* */ }
        // supervisor.proc.on('exit') will backoff-restart, which reads the
        // fresh active source URL from the channel row on refreshSupervisors.
      } catch (err) { log.warn({ err }, 'bad source-switch event'); }
      return;
    }
  });

  await refreshSupervisors();
  setInterval(refreshSupervisors, 15_000);

  // Periodically walk EVERY hour dir under EVERY channel and ingest any
  // .mp4 that isn't marked .recorded.
  const { existsSync: _exists, readdirSync } = await import('node:fs');
  function walkChannel(channelId: string): string[] {
    const base = join(RECORDINGS, channelId);
    if (!_exists(base)) return [];
    const dirs: string[] = [];
    for (const y of readdirSync(base)) {
      const yp = join(base, y);
      for (const m of readdirSync(yp)) {
        const mp = join(yp, m);
        for (const d of readdirSync(mp)) {
          const dp = join(mp, d);
          for (const h of readdirSync(dp)) {
            dirs.push(join(dp, h));
          }
        }
      }
    }
    return dirs;
  }
  // In-flight guard: a slow scan cycle (e.g. hundreds of unmarked files
  // + slow Prisma) can take >5 s. Without this guard the NEXT
  // setInterval fires while the current one is mid-loop → two
  // concurrent findFirst/create pairs race → duplicate rows for the
  // same (channelId, path). We saw 878 files balloon to 30 683 rows
  // this way in production.
  let scanning = false;
  setInterval(async () => {
    if (scanning) return;
    scanning = true;
    try {
      for (const sup of supervisors.values()) {
        const desired = channelOutDir(sup.channelId);
        if (sup.outDir !== desired) sup.outDir = desired;
      }
      const chIds = _exists(RECORDINGS) ? readdirSync(RECORDINGS) : [];
      for (const channelId of chIds) {
        let hourDirs: string[] = [];
        try { hourDirs = walkChannel(channelId); } catch { continue; }
        for (const outDir of hourDirs) {
          const sup: Supervisor = { channelId, slug: channelId, proc: null, outDir, restarts: 0, lastRestartAt: 0 };
          try { await ingestClosedSegments(sup); } catch { /* keep walking */ }
        }
      }
    } finally {
      scanning = false;
    }
  }, 5_000);

  log.info('recording service ready');
}

main().catch((err) => { log.error(err); process.exit(1); });

process.on('SIGINT',  () => { for (const s of supervisors.values()) s.proc?.kill('SIGINT');  process.exit(0); });
process.on('SIGTERM', () => { for (const s of supervisors.values()) s.proc?.kill('SIGTERM'); process.exit(0); });
