/**
 * DEMP recording service.
 *
 * Responsibilities:
 *  - Supervise one FFmpeg process per active channel that reads the source
 *    directly (UDP multicast for satellite feeds, RTSP for backups) and
 *    writes 60-second MP4 segments.
 *  - On segment close: SHA-256 the file, insert a `RecordingSegment` row,
 *    roll into the hourly `RecordingManifest` (ed25519-signed rollup).
 *  - Publish `demp:events:segment` on Redis so the UI's recording browser
 *    refreshes in real time.
 *  - Listen for `demp:jobs:clip` and render clip exports with a watermark
 *    burn-in (user + timestamp).
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

/**
 * Hard kill an ffmpeg process TREE on Windows.
 *
 * Node's proc.kill('SIGKILL') on Windows only terminates the parent
 * handle — ffmpeg's internal encoder/mux child processes survive.
 * That was the root cause of the 143-zombie / 246 GB committed leak
 * where the 90-min recycle killed the parent but children lingered
 * for 20+ hours, accumulating memory. taskkill /F /T walks the tree.
 *
 * Even taskkill /F /T can LIE on Windows: it returns success while
 * ffmpeg is kernel-blocked on UDP recvfrom (waiting on a source that
 * stopped sending packets). Node's ChildProcess emits 'exit' anyway
 * (its own handle is released), the exit handler respawns, but the
 * old ffmpeg stays alive holding the UDP socket + ~200 MB. Over the
 * 90-min age-recycle window this piles up: 2026-08-18 forensics
 * showed 78 recording ffmpegs vs 30 expected, 28/30 channels with
 * 2-3 duplicates aged hours apart, one channel with 8-in-1-second.
 * Fix: verify pidAlive after each taskkill, retry up to 3 times.
 * Mirrors the live-hls verify-loop (task #230). Returns whether the
 * kill actually succeeded — callers can decide what to do on false.
 */
function pidAlive(pid: number): boolean {
  if (process.platform !== 'win32') {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
  return (r.stdout ?? '').toLowerCase().includes('ffmpeg.exe');
}
function hardKill(proc: ChildProcess | null | undefined): boolean {
  if (!proc) return true;
  const pid = proc.pid;
  if (!pid) return true;
  if (process.platform === 'win32') {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); } catch { /* */ }
      // Give the OS ~1 s to reap the process before we check.
      spawnSync('cmd', ['/c', 'timeout', '/t', '1', '/nobreak', '>', 'NUL'], { stdio: 'ignore' });
      if (!pidAlive(pid)) return true;
    }
    log.error({ pid }, 'hardKill: recording ffmpeg still alive after 3 taskkill attempts — orphan!');
    return false;
  }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  return true;
}
type FF = ChildProcess & { stderr: NonNullable<ChildProcess['stderr']> };
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Redis from 'ioredis';
import pino from 'pino';
import { prisma } from '@cmc/db';

const log = pino({ transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' } });

const REDIS_URL     = process.env.REDIS_URL     ?? 'redis://localhost:6380';
const RECORDINGS    = resolve(process.env.RECORDINGS_DIR ?? './data/recordings');
const CLIPS         = resolve(process.env.CLIPS_DIR      ?? './data/clips');
const CLIP_ASSETS   = resolve(process.env.CLIP_ASSETS_DIR ?? './data/assets');
// 60-second segments. Every minute ffmpeg closes the current .mp4 and
// starts a new one; the closed file is SHA-256'd + inserted into the
// RecordingSegment DB table within ~2 s (scanner). This means:
//   * The Recordings page shows an ongoing recording after ~60 s, not
//     after the operator stops.
//   * The Clip Editor / session-media endpoint can stitch any date-
//     time range on demand out of the per-minute .mp4 pieces (a
//     Manager asking for "that news from 20 min ago" gets it while
//     the channel is still recording).
//   * 60 s × 30 channels × 30 days = ~1.3 M rows/month — fine for
//     Postgres, still trivial for the disk (~2 Mbps × 60 s ≈ 15 MB
//     per segment).
// The old 86400 s (24 h) value was what broke visibility: the file
// never closed unless the operator stopped, so nothing was ingested
// and the Recordings page showed empty.
const SEG_SECONDS   = Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60);
// Download budget: 500k video + 64k audio + ~30k mux overhead
// = ~594 kbps × 60s / 8 / 1024 ≈ 4.35 MB per minute. Safely under
// the 5 MB/min user requirement (1 min = 5 MB, 2 min = 10 MB, ...).
// Bumped 2026-08-20 from 500k → 1200k after operators reported visible
// blockiness (news ticker text tearing, faces pixelated) on downloaded
// clips. Combined with the 854x480 resolution below, size envelope is
// ~9.7 MB/min — well under any reasonable clip length.
const V_BITRATE     = process.env.RECORDING_VIDEO_BITRATE ?? '500k';
// Kept for the clip renderer (which still re-encodes audio at export).
// The live recorder no longer uses this because it pass-through
// remuxes from live-hls's already-AAC output.
const A_BITRATE     = process.env.RECORDING_AUDIO_BITRATE ?? '64k';
const SIGN_KEY      = process.env.MANIFEST_SIGNING_KEY   ?? 'dev-only';
const TITLE_CARD_SEC = 3;

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

/** Every recording ffmpeg pid we've spawned this process lifetime,
 *  mapped to the ms epoch when it was spawned. The orphan sweep uses
 *  this as a "young process" grace list — any ffmpeg pid that appears
 *  in wmic AND is <90s old came from us and must not be killed, even
 *  if the sweep can't otherwise link it to a live supervisor (race
 *  windows: pid recycling on Windows, tracked-set inspection during
 *  a mid-respawn tick, or the ffmpeg being reaped but its record
 *  lingering in wmic for a beat).
 *
 *  2026-08-20 evening: abb-tak restart-looped every ~20 s because
 *  the sweep was killing its just-spawned live ffmpeg — the exit
 *  handler fired 86 ms after the orphan kill each cycle.  */
const recentlySpawnedPids = new Map<number, number>();
/** Sweep is expensive (wmic ~50-100 ms) and dangerous (can race with
 *  a spawn). Only run at this cadence, not once per refresh tick.  */
const ORPHAN_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastOrphanSweepAt = 0;

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

// Slugs whose source has infrequent keyframes / non-progressive stream
// so `-c copy` produces 0-byte segments (no I-frame to start on). For
// these we transcode with libx264 ultrafast + `-force_key_frames` at
// every segment boundary — one keyframe per 60 s guaranteed.
// Force-transcode slugs — channels whose source has slow keyframes
// (or DTS quirks) that break `-c copy`'s segment muxer, so segments
// either never close (file stays 0 bytes until next keyframe, minutes
// later) or ffmpeg crash-loops. For these we re-encode at NATIVE
// resolution with a 2-s keyframe cadence so 60-s segments cut cleanly.
// Everything downstream (download / clip export) still re-encodes to
// 854x480 for the operator's target profile — this list only exists
// because the source itself isn't friendly to a byte-copy pipeline.
const RECORDING_TRANSCODE_SLUGS = new Set(
  (process.env.RECORDING_TRANSCODE_SLUGS ??
    'cnn,365-news,gtv-news,samaa-news,92-news,bol-news,aik-news,ary-news')
    .split(',').map((s) => s.trim()).filter(Boolean),
);
// Download / clip target — everything above is about the on-disk
// recording, not the download. The download endpoint reads these.
const REC_W = Number(process.env.RECORDING_W ?? 854);
const REC_H = Number(process.env.RECORDING_H ?? 480);
const REC_PRESET = process.env.RECORDING_PRESET ?? 'veryfast';

/** Probe primary video codec of a UDP MPEG-TS source (~3 s, once at
 *  supervisor start). Returns "h264" / "hevc" / "mpeg2video" / etc.
 *  or null on failure. Needed so recordings from non-H.264 channels
 *  (e.g. MPEG-2 ARY / SD feeds) get transcoded to H.264 — otherwise
 *  the .mp4 has an audio-only playable track in Chrome/Edge/hls.js. */
function probeVideoCodec(sourceUrl: string, kind: string): string | null {
  let input = sourceUrl.trim();
  if (kind === 'UDP' || kind === 'RTP') {
    if (input.includes('://') && !input.split('://', 2)[1]!.startsWith('@')) {
      const [proto, rest] = input.split('://', 2);
      input = `${proto!.toLowerCase()}://@${rest}`;
    }
    const localaddr = process.env.RECORDING_LOCALADDR ?? process.env.LOCALADDR ?? '';
    const parts: string[] = ['fifo_size=8000000', 'overrun_nonfatal=1', 'reuse=1'];
    if (localaddr) parts.push(`localaddr=${localaddr}`);
    input = `${input}${input.includes('?') ? '&' : '?'}${parts.join('&')}`;
  }
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'info',
    '-analyzeduration', '3000000', '-probesize', '3000000',
    '-t', '2',
    '-f', 'mpegts',
    '-i', input,
    '-f', 'null', '-',
  ];
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8', timeout: 8000 });
  const stderr = res.stderr ?? '';
  const m = stderr.match(/Stream #\d+:\d+[^\n]*Video:\s*([a-z0-9_]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

// Persistent per-channel codec cache — avoid re-probing on every
// supervisor restart. Populated on first spawn per channel.
const channelCodec = new Map<string, string | null>();

function spawnFFmpeg(slug: string, sourceUrl: string, kind: string, outDir: string): FF {
  mkdirSync(outDir, { recursive: true });
  const outPattern = join(outDir, '%M.mp4');

  // ARCHITECTURE — 2026-08-08: back to UDP-direct after the HLS-tap
  // approach failed. ffmpeg's HLS file demuxer stalls after the source
  // playlist's `delete_segments` window slides past its read pointer:
  // it opens seg_N.ts, reads it, tries to advance, next file has
  // already been unlinked by live-hls, demuxer stops emitting frames.
  // All 30 recorders froze at exactly the same second with the file
  // handle still open. Reading UDP directly costs one extra multicast
  // subscriber per channel but the CPU stays trivial (~1 % one core
  // per stream with -c copy) and the pipeline never depends on
  // another process's file-write cadence.
  //
  // NIC split: LOCALADDR (172.16.205.20) is what live-hls uses.
  // Recording uses RECORDING_LOCALADDR when set (10.51.80.202 on the
  // Storage2 NIC) so the two workloads land on separate physical
  // ports — reduces IGMP-snooping load on any single switch port.
  let input = sourceUrl.trim();
  if (kind === 'UDP' || kind === 'RTP') {
    if (input.includes('://') && !input.split('://', 2)[1]!.startsWith('@')) {
      const [proto, rest] = input.split('://', 2);
      input = `${proto!.toLowerCase()}://@${rest}`;
    }
    const localaddr = process.env.RECORDING_LOCALADDR ?? process.env.LOCALADDR ?? '';
    const parts: string[] = [];
    // fifo_size = ffmpeg internal circular buffer (10 MB, safe to raise)
    // buffer_size = SO_RCVBUF kernel socket buffer. Keep at 8 MB —
    // Windows fails ANY new UDP bind with "Cannot allocate memory"
    // when total pinned kernel socket buffers across all sockets
    // exceed ~800 MB. 60 sockets × 16 MB tips the limit; 60 × 8 MB
    // fits comfortably.
    if (!input.includes('fifo_size='))         parts.push('fifo_size=8000000');
    if (!input.includes('overrun_nonfatal='))  parts.push('overrun_nonfatal=1');
    if (!input.includes('timeout='))           parts.push('timeout=60000000');
    if (!input.includes('buffer_size='))       parts.push('buffer_size=8388608');
    if (!input.includes('reuse='))             parts.push('reuse=1');
    if (localaddr && !input.toLowerCase().includes('localaddr=')) {
      parts.push(`localaddr=${localaddr}`);
    }
    if (parts.length) {
      input = `${input}${input.includes('?') ? '&' : '?'}${parts.join('&')}`;
    }
  }

  // Ingest strategy — CPU-first, quality-preserving:
  //   * H.264 sources → `-c copy` (raw). No re-encode, near-zero CPU,
  //     source native resolution + bitrate preserved on disk. Clip /
  //     download endpoints do the target-profile re-encode on demand.
  //   * Non-H.264 sources → transcode to H.264 at NATIVE resolution
  //     so the file plays in the browser without a client-side
  //     decoder that hls.js can't drive. Still no downscale here —
  //     any resolution shaping happens at export time.
  //
  // 2026-08-26: reverted from a universal 854x480 veryfast transcode
  // that pushed the 112-core box to 95%+ CPU (30 encoders × 2 cores
  // + live-hls's 30 encoders + everything else = hang). Per operator
  // request, quality shaping now happens ONLY on download / clip
  // export, not on the 24/7 ingest.
  if (!channelCodec.has(slug)) {
    log.info({ slug }, 'probing source codec (once)');
    channelCodec.set(slug, probeVideoCodec(sourceUrl, kind));
    log.info({ slug, codec: channelCodec.get(slug) }, 'source codec detected');
  }
  const codec = channelCodec.get(slug);
  // Transcode when: source isn't h264 (browser can't play) OR the
  // source is on the "slow-KF" list (segment muxer needs the 2-s
  // forced keyframes we add below to cut 60-s segments cleanly).
  const needsTranscode = RECORDING_TRANSCODE_SLUGS.has(slug)
    || (codec !== undefined && codec !== 'h264');
  const videoArgs = needsTranscode
    ? [
        // Re-encode at NATIVE resolution — no -vf scale here so
        // the download/clip re-encode later has full source pixels
        // to work from. Preset veryfast keeps the CPU trivial on
        // the 8 known transcode channels; if we ever add more to
        // the list, this scales gracefully.
        '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
        '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-threads', '2',
        '-b:v', '2000k', '-maxrate', '3000k', '-bufsize', '6000k',
        '-force_key_frames', 'expr:gte(t,n_forced*2)',
      ]
    : ['-c:v', 'copy'];
  const audioArgs = needsTranscode
    ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000']
    : ['-c:a', 'copy'];
  if (needsTranscode) log.info({ slug, w: REC_W, h: REC_H }, 'recording will transcode');

  const args = [
    '-hide_banner', '-loglevel', 'warning', '-nostdin',
    // +igndts added 2026-08-21: abb-tak source emits non-monotonic DTS
    // ("Application provided invalid, non monotonically increasing dts
    // to stream 1") which VLC / clip render (has +igndts) tolerate but
    // the recording ingest was exiting with Windows crash code
    // 0xBEBE4BB7 within seconds → respawn burst → 4 extra ffmpegs.
    '-fflags', '+genpts+discardcorrupt+igndts',
    '-err_detect', 'ignore_err',
    // Bigger input queue absorbs source hiccups (IGMP renegotiation,
    // NIC-driver interrupt storm) without dropping segments.
    '-thread_queue_size', '512',
    // VLC-tolerant probing — match live-hls. Bumped to 40s/50MB
    // after observing CNN take ~30s to lock in VLC (2026-08-18).
    '-analyzeduration', '40000000',
    '-probesize', '50000000',
    ...(kind === 'UDP' || kind === 'RTP' ? ['-f', 'mpegts'] : []),
    '-i', input,
    // Optional video map — audio-only bursts don't crash the recorder.
    '-map', '0:v:0?', '-map', '0:a?', '-dn', '-sn',
    ...videoArgs,
    ...audioArgs,
    '-f', 'segment',
    '-segment_time', String(SEG_SECONDS),
    '-segment_format', 'mp4',
    // Fragmented MP4 — moov is written at file OPEN time (empty +
    // default_base_moof), followed by moof/mdat pairs as frames arrive.
    // Contrast with +faststart which requires a second pass at file
    // CLOSE time to move the moov to the front; if the recorder is
    // killed (service restart, crash, SIGINT during a segment) that
    // second pass never runs and the resulting file has raw H.264
    // data but no MP4 structure — completely unplayable, no possible
    // remux. fMP4 avoids that failure mode entirely; every segment
    // is playable the instant it starts writing.
    '-segment_format_options', 'movflags=+frag_keyframe+empty_moov+default_base_moof',
    '-reset_timestamps', '1',
    '-strftime', '1',
    outPattern.replace('%M', '%Y%m%dT%H%M%SZ'),
  ];

  log.info({ slug, input, outDir, outPattern }, 'recorder ffmpeg spawn');
  // stdin: 'pipe' so we can send 'q' for graceful shutdown. On Windows
  // SIGINT doesn't cleanly stop ffmpeg — the process just gets killed
  // and the mp4 file may be corrupt. Sending 'q' to stdin flushes the
  // muxer trailer, closes the file cleanly, and exits with code 255
  // (which we treat as a clean stop in the exit handler).
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  // Register spawn time BEFORE anything else that could throw or await
  // so the orphan sweep never races with a barely-alive pid.
  if (typeof proc.pid === 'number') {
    recentlySpawnedPids.set(proc.pid, Date.now());
    // Cheap GC: drop entries older than 30 min so the map can't grow
    // unbounded over a long service lifetime.
    if (recentlySpawnedPids.size > 500) {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [k, v] of recentlySpawnedPids) {
        if (v < cutoff) recentlySpawnedPids.delete(k);
      }
    }
  }
  proc.stderr.on('data', (b) => {
    const line = b.toString().trim();
    if (line && !line.startsWith('frame=')) log.debug({ slug }, line.slice(0, 200));
  });
  return proc;
}

/** Graceful stop for a recorder ffmpeg — send 'q' on stdin, then hard
 *  kill after 3 s if it's still alive. Windows-safe (SIGINT via .kill
 *  isn't reliable on Windows and can leave partial fMP4 files). */
function stopFFmpegGracefully(sup: Supervisor): void {
  const p = sup.proc;
  if (!p) return;
  try {
    if (p.stdin && !p.stdin.destroyed) {
      p.stdin.write('q\n');
      p.stdin.end();
    }
  } catch { /* stdin already closed */ }
  // Escalate to hard kill after 3 s.
  setTimeout(() => {
    if (sup.proc && sup.proc === p && p.exitCode === null && p.signalCode === null) {
      log.warn({ slug: sup.slug }, 'ffmpeg did not exit on q, force killing');
      hardKill(p);
    }
  }, 3000);
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
      // ffmpeg's `-strftime 1` uses LOCAL time on Windows even though
      // our filename template ends in `Z`. Was: parse as UTC which
      // shifted every startedAt by the server's UTC offset (PKT = +5 h)
      // and made "last 10 minutes" filters miss all fresh recordings.
      // Now: parse the digits as local time to match what ffmpeg wrote.
      const m = f.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mp4$/);
      const startedAt = m
        ? new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
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
      log.info({ id, slug: sup.slug }, 'stopping supervisor (recording toggled OFF)');
      (sup as Supervisor & { _stopped?: boolean })._stopped = true;   // suppress the auto-restart handler
      stopFFmpegGracefully(sup);
      supervisors.delete(id);
      continue;
    }
    // Safety net: if a supervisor is present but its proc died and
    // the exit handler didn't respawn (e.g. handler regression, spawn
    // exception, unhandled event), drop the map entry so the next block
    // recreates it from scratch on this same tick.
    const p = sup.proc;
    const dead = !p || p.exitCode !== null || p.signalCode !== null;
    const idleSince = Date.now() - sup.lastRestartAt;
    if (dead && idleSince > 60_000) {
      log.warn({ id, slug: sup.slug, exitCode: p?.exitCode, signalCode: p?.signalCode, idleSince },
               'supervisor has no live proc — reseeding');
      // Mark stopped BEFORE delete so any exit-handler setTimeouts
      // still queued against this sup bail via their `if (sup._stopped)`
      // guard. Without this the queued respawn fires 500 ms later, sees
      // no sup in the Map for its channelId, and spawns a duplicate.
      (sup as Supervisor & { _stopped?: boolean })._stopped = true;
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

    // Wraps spawn + attaches the exit handler in one place so respawns
    // don't drop the handler. Was: handler attached ONCE on the initial
    // proc; the setTimeout respawn reassigned sup.proc without wiring a
    // new handler → second ffmpeg died silently → whole channel stalled.
    const spawnAndWatch = () => {
      sup.outDir = channelOutDir(sup.channelId);
      sup.lastRestartAt = Date.now();
      const p = spawnFFmpeg(c.slug, primary.url, primary.kind, sup.outDir);
      sup.proc = p;
      p.on('exit', (code) => {
        if (sup._stopped) return;
        log.warn({ slug: c.slug, code, restarts: sup.restarts }, 'recorder ffmpeg exited');
        const now = Date.now();
        sup.restarts = now - sup.lastRestartAt > 30_000 ? 0 : sup.restarts + 1;
        // Chronic-offender cooldown: when the upstream source dies
        // (satellite decoder off, provider outage), every channel's
        // ffmpeg starts exiting near-immediately. Without a hard cap
        // this spawns tens of ffmpegs per channel in a short window
        // (observed: 155 concurrent when source dropped for ~15 min).
        // >20 restarts = source is down, wait 5 min between attempts.
        const delay = sup.restarts > 20
          ? 300_000
          : Math.min(30_000, 500 * 2 ** Math.min(sup.restarts, 5));
        setTimeout(() => {
          if (sup._stopped) return;
          // Race guard: if the safety-net "reseed" already ran
          // (supervisors.delete + fresh spawn on next refreshSupervisors
          // tick), a NEW supervisor for this channel is now in the Map
          // and has its own ffmpeg. Respawning from this closure would
          // duplicate the ffmpeg (orphan we can't track). Skip.
          //
          // 2026-08-21: abb-tak crash-loop was spawning 4 ffmpegs
          // simultaneously because 4 exit-handler setTimeouts all fired
          // after their sup had been deleted+reseeded.
          const current = supervisors.get(c.id);
          if (current !== sup) {
            log.info({ slug: c.slug }, 'respawn skipped — supervisor already reseeded by safety-net');
            return;
          }
          try { spawnAndWatch(); }
          catch (err) { log.error({ err, slug: c.slug }, 'respawn threw — will retry on next refresh tick'); }
        }, delay);
      });
      p.on('error', (err) => {
        log.warn({ err, slug: c.slug }, 'ffmpeg spawn error');
      });
    };

    try { spawnAndWatch(); }
    catch (err) { log.error({ err, slug: c.slug }, 'initial spawn threw'); }
    supervisors.set(c.id, sup);
  }

  // ORPHAN SWEEP — throttled + young-process safe.
  //
  // The sweep exists as a belt-and-suspenders against exotic leaks
  // (Node exception between spawnFFmpeg() and sup.proc assignment,
  // a taskkill that fooled the verify loop). BUT it is dangerous
  // because tracked-set inspection can miss legitimate ffmpegs
  // during a mid-respawn tick — and taskkilling a live recorder
  // triggers immediate segment loss.
  //
  // Two guards make this safe:
  //   1. Cadence: only run every ORPHAN_SWEEP_INTERVAL_MS (5 min),
  //      not once per refresh tick. Real orphans persist forever
  //      until killed; there's no cost to waiting 5 min to reap them.
  //   2. Age filter: any pid recentlySpawnedPids.has() OR that wmic
  //      reports as <90s old is exempt. That covers the entire
  //      race window (spawn → assign → next tick sees it) without
  //      opening a leak window (a real orphan will still be here
  //      when the 5-min timer fires).
  //
  // 2026-08-20 evening: abb-tak had 17 restart-loops in an hour
  // because the old sweep was killing its just-spawned live ffmpeg
  // every ~20 s — the exit fired 86 ms after the orphan kill each
  // cycle.
  if (process.platform !== 'win32') return;
  const nowMs = Date.now();
  if (nowMs - lastOrphanSweepAt < ORPHAN_SWEEP_INTERVAL_MS) return;
  lastOrphanSweepAt = nowMs;
  try {
    const tracked = new Set<number>();
    for (const sup of supervisors.values()) {
      const pid = sup.proc?.pid;
      if (typeof pid === 'number') tracked.add(pid);
    }
    // Ask wmic for CreationDate too so we can compute per-pid age.
    const wmic = spawnSync('wmic', ['process', 'where', "name='ffmpeg.exe'",
      'get', 'ProcessId,CommandLine,CreationDate', '/format:csv'], { encoding: 'utf8' });
    const orphans: number[] = [];
    const skippedYoung: number[] = [];
    for (const line of (wmic.stdout ?? '').split(/\r?\n/)) {
      // Only recording ffmpegs (cmdline references D:\cmc\recordings).
      if (!line.toLowerCase().includes(RECORDINGS.toLowerCase())) continue;
      const parts = line.trim().split(',');
      // csv layout (with /format:csv): Node,CommandLine,CreationDate,ProcessId
      const pid = Number(parts[parts.length - 1]);
      const created = parts[parts.length - 2] ?? '';
      if (!Number.isInteger(pid) || pid <= 0) continue;
      if (tracked.has(pid)) continue;
      // Grace: pids we spawned recently, even if not currently tracked
      // (respawn window), are ours.
      const ourSpawnAt = recentlySpawnedPids.get(pid);
      if (typeof ourSpawnAt === 'number' && nowMs - ourSpawnAt < 90_000) {
        skippedYoung.push(pid);
        continue;
      }
      // WMI CreationDate is `YYYYMMDDHHmmss.ffffff+ZZZ` local time.
      // Parse the first 14 digits as local wall-clock, compare in ms.
      const m = created.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
      if (m) {
        const spawned = new Date(
          Number(m[1]), Number(m[2]) - 1, Number(m[3]),
          Number(m[4]), Number(m[5]), Number(m[6]),
        ).getTime();
        if (nowMs - spawned < 90_000) {
          skippedYoung.push(pid);
          continue;
        }
      }
      orphans.push(pid);
    }
    if (skippedYoung.length > 0) {
      log.info({ count: skippedYoung.length, pids: skippedYoung.slice(0, 8) },
               'orphan sweep: skipping young ffmpegs (<90s) — probably ours mid-spawn');
    }
    if (orphans.length > 0) {
      log.warn({ count: orphans.length, pids: orphans.slice(0, 8) },
               'orphan recording ffmpegs found (untracked, >90s old) — killing');
      for (const pid of orphans) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
        catch { /* noop */ }
      }
    }
  } catch (err) { log.warn({ err }, 'orphan sweep failed (non-fatal)'); }
}

/** Escape a user-supplied string for use inside a drawtext text= value.
 * Windows ffmpeg reads argv as ANSI so anything non-printable-ASCII
 * turns into a garbled multibyte sequence that drawtext rejects with
 * "Invalid argument"; :\\% are drawtext option/escape metacharacters.  */
function escapeForDrawtext(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/'/g, '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');
}

/** Wrap an ffmpeg invocation as a Promise so we can await + capture stderr. */
function runFfmpeg(args: string[], stage: string): Promise<void> {
  return new Promise((resolve2, reject) => {
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    p.stderr.on('data', (b) => { tail += b.toString(); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0
      ? resolve2()
      : reject(new Error(`ffmpeg ${stage} exit ${code} — last stderr: ${tail.slice(-500)}`)));
  });
}

async function clipWorker(job: { clipId: string }) {
  const clip = await prisma.clip.findUnique({
    where: { id: job.clipId },
    include: { channel: { select: { name: true, slug: true } } },
  });
  if (!clip) return;
  await prisma.clip.update({ where: { id: clip.id }, data: { status: 'RENDERING' } });
  log.info({ clipId: clip.id }, 'rendering clip');

  mkdirSync(CLIPS, { recursive: true });
  const outFile = join(CLIPS, `${clip.id}.${clip.format.toLowerCase()}`);

  // Locate the underlying .mp4 files DIRECTLY FROM DISK, not from the
  // RecordingSegment table. The recording ffmpegs write to a
  // deterministic path — RECORDINGS_DIR/<channelId>/YYYY/MM/DD/HH/
  // YYYYMMDDTHHMMSSZ.mp4 (local time, per ffmpeg's -strftime on
  // Windows). We compute every hour-dir the clip window touches,
  // readdir each, parse filenames back to timestamps, and keep files
  // whose [fileStart, fileStart+SEG_SECONDS] window overlaps
  // [clip.startAt, clip.endAt]. This makes clip creation independent
  // of the DB ingest pipeline — user can clip a moment that just
  // happened, or one from days ago, and it works as long as the .mp4
  // is on disk. Prior implementation queried RecordingSegment which
  // FAILED whenever ingest lag left a gap (2026-08-20: 4 clips failed
  // because Aug 18/19 segments never landed in DB).
  interface CoveringFile { path: string; startedAt: Date }
  const covering: CoveringFile[] = [];
  // channelOutDir() writes hour-dirs using UTC (getUTCHours) at SPAWN
  // time, and the ffmpeg process keeps writing to that same dir until
  // it exits — it does NOT rotate dirs on the hour. So a segment for
  // UTC hour H can physically live in dir H, H-1, H-2, ... depending
  // on when the process started. Filename filter below still restricts
  // to the clip window, so widening the scan is safe.
  //
  // 2026-08-20 GTV incident: clip at 14:01 UTC failed with "no covering
  // files" because ffmpeg (spawned during UTC 13) was still writing to
  // /2026/08/20/13/ — dir /2026/08/20/14/ didn't exist yet.
  //
  // Also handles the earlier PKT-vs-UTC bug: filename is LOCAL time,
  // dir is UTC hour — filename regex parses local, we compare in real
  // ms so it stays correct across the boundary.
  const firstHour = new Date(clip.startAt); firstHour.setUTCMinutes(0, 0, 0);
  firstHour.setUTCHours(firstHour.getUTCHours() - 6);
  const lastHour  = new Date(clip.endAt);   lastHour.setUTCMinutes(0, 0, 0);
  lastHour.setUTCHours(lastHour.getUTCHours() + 1);
  log.info({
    clipId: clip.id,
    tzOffsetMin: -new Date().getTimezoneOffset(),
    startAt_iso: clip.startAt.toISOString(),
    endAt_iso: clip.endAt.toISOString(),
    firstHour_iso: firstHour.toISOString(),
    lastHour_iso: lastHour.toISOString(),
  }, 'clip: covering scan starting');
  for (let cur = new Date(firstHour); cur.getTime() <= lastHour.getTime(); cur = new Date(cur.getTime() + 3600_000)) {
    const dir = join(
      RECORDINGS, clip.channelId,
      String(cur.getUTCFullYear()),
      String(cur.getUTCMonth() + 1).padStart(2, '0'),
      String(cur.getUTCDate()).padStart(2, '0'),
      String(cur.getUTCHours()).padStart(2, '0'),
    );
    const dirExists = existsSync(dir);
    log.info({ clipId: clip.id, dir, dirExists }, 'clip: probing hour dir');
    if (!dirExists) continue;
    let names: string[] = [];
    try { names = readdirSync(dir); } catch (err) { log.warn({ clipId: clip.id, dir, err }, 'clip: readdir failed'); continue; }
    let matched = 0;
    for (const n of names) {
      const m = n.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.mp4$/);
      if (!m) continue;
      const fileStart = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
      const fileEnd   = new Date(fileStart.getTime() + SEG_SECONDS * 1000);
      if (fileEnd > clip.startAt && fileStart < clip.endAt) {
        covering.push({ path: join(dir, n), startedAt: fileStart });
        matched++;
      }
    }
    log.info({ clipId: clip.id, dir, totalEntries: names.length, matched }, 'clip: dir scan complete');
  }
  covering.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());

  if (covering.length === 0) {
    await prisma.clip.update({ where: { id: clip.id }, data: { status: 'FAILED' } });
    log.warn({ clipId: clip.id, channelId: clip.channelId, startAt: clip.startAt, endAt: clip.endAt },
             'no covering .mp4 files on disk for requested window');
    return;
  }

  // Build ffmpeg input args. Single file → -ss/-to trim. Multiple files
  // → concat demuxer + trim relative to first file's start.
  const first = covering[0]!;
  const ss = Math.max(0, (clip.startAt.getTime() - first.startedAt.getTime()) / 1000);
  const totalSpan = (covering[covering.length - 1]!.startedAt.getTime() + SEG_SECONDS * 1000 - first.startedAt.getTime()) / 1000;
  const to = Math.min(totalSpan, (clip.endAt.getTime() - first.startedAt.getTime()) / 1000);
  const duration = Math.max(1, to - ss);
  // Clip renders at 1280x720 canvas with content in a centered 640x360
  // area, black padding around. Ingest source is 640x360 (kept small
  // so 30 concurrent encoders fit in CPU budget) — the letterbox
  // padding happens HERE at clip time, one render at a time, no CPU
  // pressure. Result: fullscreen playback upscales 1280→1920 (1.5x)
  // instead of 640→1920 (3x), so faces/tickers stay sharp. Black
  // padding compresses to almost nothing so file size stays around
  // the same as a raw 640x360@700k encode.
  void clip.resolution;   // legacy UI field, no longer used
  // Clip export resolution now matches ingest (854x480) so we
  // never upscale a source pixel and every clip stays at the same
  // per-minute size the operator sees for recordings (~5 MB/min).
  const w = REC_W, h = REC_H;

  // If multiple files, write a concat list file for ffmpeg's concat
  // demuxer (safer than concat filter for pre-encoded MP4 pieces).
  // Tolerance flags applied to EVERY clip input. UDP-copy recordings
  // (most channels) can have truncated H.264 SEI, PID discontinuities,
  // and missing PES headers when packet loss hits mid-frame. Without
  // these flags, the render dies with `SEI type X size Y truncated at
  // Z / ffmpeg main exit 1` and the whole clip fails. With them,
  // ffmpeg skips the bad frame and continues.
  //
  // 2026-08-20: neo-news + aik-news clips failed exactly this way after
  // the covering-file scan was already finding the segment.
  const TOLERANCE_IN = [
    '-fflags', '+discardcorrupt+igndts+genpts',
    '-err_detect', 'ignore_err',
    '-ec', 'guess_mvs+deblock',
    '-analyzeduration', '20000000',
    '-probesize', '20000000',
  ];
  let ffInputArgs: string[];
  const concatListPath = join(tmpdir(), `clip-concat-${clip.id}.txt`);
  if (covering.length === 1) {
    ffInputArgs = [...TOLERANCE_IN, '-ss', String(ss), '-to', String(Math.max(ss + 1, to)), '-i', first.path];
  } else {
    const lines = covering.map((c) => `file '${c.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n');
    writeFileSync(concatListPath, lines);
    ffInputArgs = [
      ...TOLERANCE_IN,
      '-f', 'concat', '-safe', '0',
      '-ss', String(ss), '-to', String(Math.max(ss + 1, to)),
      '-i', concatListPath,
    ];
  }
  log.info({ clipId: clip.id, files: covering.length, span_s: totalSpan, ss, to }, 'clip: covering files located');

  // Watermark text — email + timestamp — flattened + ASCII-safe.
  const wmRaw = (clip.watermarkText ?? '').replace(/'/g, '');
  const wm = escapeForDrawtext(wmRaw.replace(/T(\d\d):(\d\d):(\d\d)(\.\d+)?Z/, ' $1-$2-$3 UTC'));

  // drawtext fontfile: single-backslash-colon ('C\:/...') gets split
  // by the Windows parser; double-backslash-colon ('C\\:/...') is the
  // form that survives. Fontconfig isn't shipped on the Windows build
  // so a wrong path here segfaults — do NOT pass a Linux path there.
  const FONT_BOLD = process.platform === 'win32'
    ? String.raw`C\\:/Windows/Fonts/arialbd.ttf`
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
  const FONT_REG  = process.platform === 'win32'
    ? String.raw`C\\:/Windows/Fonts/arial.ttf`
    : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

  // Branding watermarks disabled per operator request. Clips get a
  // single narrow bottom watermark strip carrying user + timestamp for
  // chain-of-custody only — no PAK NAVY / Analysys logos, no big
  // corner text.
  const hasBranding = false;
  void CLIP_ASSETS;

  // Only MP4 / MOV benefit from +faststart. MKV ignores it; WebM
  // would need libvpx-vp9 + libopus and is disabled at the UI layer.
  const isMovLike = clip.format === 'MP4' || clip.format === 'MOV';

  // Two-pass render: main content first, then prepend title card via
  // concat filter. One-pass is possible but the audio-branch handling
  // (source-audio-or-silent + concat-with-silent-intro) inside a
  // single filter graph is brittle; splitting keeps each pass
  // trivially debuggable.
  const workDir = mkdtempSync(join(tmpdir(), `clip-${clip.id}-`));
  const mainPath = join(workDir, `main.${clip.format.toLowerCase()}`);

  try {
    // ============================================================ Pass 1: main
    // Clean video with just a discreet chain-of-custody watermark
    // strip at the bottom (user email + timestamp). No PAK NAVY /
    // Analysys logos anywhere — the operator asked for un-branded
    // exports.
    void FONT_BOLD;   // unused now (was for PAK NAVY corner text)
    // Watermark strip removed 2026-08-25 per operator request. Kept
    // wm/FONT_* references live above so a future re-enable is a
    // one-line change back.
    void wm; void FONT_REG;
    // Pure stretch — same as ingest. No pillars, no letterbox. If the
    // source is already this exact size the scaler is essentially a
    // no-op, no quality loss.
    const scalePrefix = (w > 0 && h > 0)
      ? `scale=${w}:${h}:flags=lanczos`
      : 'null';
    const mainFilter: string[] = [`[0:v]${scalePrefix}[outv]`];

    const mainArgs: string[] = [
      '-hide_banner', '-loglevel', 'warning',
      ...ffInputArgs,
      // Silent audio fallback — mapped only if source has no audio.
      '-f', 'lavfi', '-t', String(duration + 1), '-i', 'anullsrc=r=48000:cl=stereo',
    ];
    // Branding disabled — PAK_LOGO/ANL_LOGO removed; keep gate false-only path.
    // if (hasBranding) mainArgs.push('-i', PAK_LOGO, '-i', ANL_LOGO);
    void hasBranding;
    mainArgs.push(
      '-filter_complex', mainFilter.join(';'),
      '-map', '[outv]',
      '-map', '0:a:0?', '-map', '1:a:0',
      '-shortest',
      // Match the ingest bitrate exactly — clip = watermarked passthrough
      // in terms of bytes. Ingest is 700k VBR-capped; we output at the
      // same 700k so a 60-s clip is ~5.5 MB (matches a 60-s source
      // segment). No compress-below-source regression possible.
      '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '700k',
      '-maxrate', '1000k', '-bufsize', '2000k',
      '-c:a', 'aac', '-b:a', A_BITRATE, '-ac', '2', '-ar', '48000',
      ...(isMovLike ? ['-movflags', '+faststart'] : []),
      '-y', mainPath,
    );
    log.info({ clipId: clip.id }, 'ffmpeg pass 1 — main content');
    await runFfmpeg(mainArgs, 'main');

    // Title card pass removed 2026-08-08 — operator wants the raw
    // clip video only, no PAK NAVY / Analysys title-card intro.
    // The pass-1 output IS the final clip; just move it into place.
    const { renameSync } = await import('node:fs');
    try { renameSync(mainPath, outFile); }
    catch { const { copyFileSync } = await import('node:fs'); copyFileSync(mainPath, outFile); }

    const size = statSync(outFile).size;
    const hash = await sha256(outFile);
    await prisma.clip.update({ where: { id: clip.id }, data: {
      status: 'READY', path: outFile, sizeBytes: BigInt(size), sha256: hash,
    } });
    log.info({ clipId: clip.id, sizeMB: (size / 1024 / 1024).toFixed(1) }, 'clip ready');
  } catch (err) {
    log.error({ err, clipId: clip.id }, 'clip render failed');
    await prisma.clip.update({ where: { id: clip.id }, data: { status: 'FAILED' } });
    try { unlinkSync(outFile); } catch { /* */ }
  } finally {
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* */ }
    try { unlinkSync(concatListPath); } catch { /* file may not exist for single-file clips */ }
  }
}

function hasFfmpeg(): boolean {
  try { return spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

async function main() {
  mkdirSync(RECORDINGS, { recursive: true });

  // STARTUP ZOMBIE SWEEP. Any ffmpeg orphaned by a previous
  // recording-service crash keeps recording indefinitely with no
  // parent to reap it. Multiple crash cycles pile up hundreds of
  // zombies (144 observed post-mortem, 250 GB committed). Kill any
  // ffmpeg whose cmdline references D:\cmc\recordings before we
  // spawn our own.
  if (process.platform === 'win32') {
    try {
      const marker = RECORDINGS.toLowerCase();
      const wmic = spawnSync('wmic', ['process', 'where', "name='ffmpeg.exe'",
        'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8' });
      const pids: number[] = [];
      for (const line of (wmic.stdout ?? '').split(/\r?\n/)) {
        if (!line.toLowerCase().includes(marker)) continue;
        const parts = line.trim().split(',');
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
      for (const pid of pids) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
        catch { /* noop */ }
      }
      if (pids.length > 0) log.info({ count: pids.length }, 'startup: killed orphan recording ffmpeg zombies');
    } catch (err) { log.warn({ err }, 'startup zombie sweep failed'); }
  }
  mkdirSync(CLIPS, { recursive: true });

  if (!hasFfmpeg()) {
    log.warn('ffmpeg not found on PATH — recording service will idle. Install FFmpeg (winget install Gyan.FFmpeg) and restart.');
    // Idle heartbeat every 60s so restart-on-crash supervisors don't churn.
    setInterval(() => { /* idle */ }, 60_000);
    return;
  }

  // Startup catch-up: Redis pub/sub is fire-and-forget. Any clip that
  // was submitted while this service was down is stuck in QUEUED
  // forever unless we re-process it. Sweep the DB on boot and enqueue
  // every non-terminal clip so past bol-news style clips actually
  // render out. Sequential to keep CPU sane; there are usually 0-5.
  try {
    const queued = await prisma.clip.findMany({
      where: { status: { in: ['QUEUED', 'RENDERING'] } },
      select: { id: true, title: true, status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (queued.length) {
      log.info({ count: queued.length }, 'catch-up: found queued clips, re-processing');
      // If it was mid-render when we crashed, revert to QUEUED so
      // clipWorker's own state transitions still fire.
      const midRender = queued.filter((c) => c.status === 'RENDERING').map((c) => c.id);
      if (midRender.length) {
        await prisma.clip.updateMany({ where: { id: { in: midRender } }, data: { status: 'QUEUED' } });
      }
      // Fire and forget — each clipWorker is async.
      for (const c of queued) void clipWorker({ clipId: c.id });
    }
  } catch (err) {
    log.warn({ err }, 'catch-up sweep failed (non-fatal)');
  }

  // Periodic sweep — belt + suspenders against lost Redis pub/sub
  // messages. Every 30 s look for any clip stuck in QUEUED or that has
  // been "RENDERING" for over 5 min (dead worker). Re-enqueue by
  // calling clipWorker directly. Dedup via activeClipIds so a clip
  // that IS actively being processed isn't fired again.
  const activeClipIds = new Set<string>();
  async function sweepStuckClips(): Promise<void> {
    try {
      const stale = await prisma.clip.findMany({
        where: {
          OR: [
            { status: 'QUEUED' },
            // RENDERING clips whose row hasn't been touched in >5 min
            // = worker died mid-render (updatedAt bumps on every state
            // transition).
            { status: 'RENDERING', updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
          ],
        },
        select: { id: true, status: true },
        take: 20,
      });
      for (const c of stale) {
        if (activeClipIds.has(c.id)) continue;
        activeClipIds.add(c.id);
        if (c.status === 'RENDERING') {
          try { await prisma.clip.update({ where: { id: c.id }, data: { status: 'QUEUED' } }); } catch { /* */ }
        }
        log.info({ clipId: c.id, was: c.status }, 'sweep: reprocessing orphan clip');
        void clipWorker({ clipId: c.id })
          .finally(() => activeClipIds.delete(c.id));
      }
    } catch (err) {
      log.warn({ err }, 'clip sweep failed');
    }
  }
  setInterval(sweepStuckClips, 30_000);
  // First sweep immediately on boot too (redundant with catch-up above,
  // but harmless — dedup guard skips already-active clips).
  setTimeout(sweepStuckClips, 5_000);

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
        stopFFmpegGracefully(sup);
        // supervisor.proc.on('exit') will backoff-restart, which reads the
        // fresh active source URL from the channel row on refreshSupervisors.
      } catch (err) { log.warn({ err }, 'bad source-switch event'); }
      return;
    }
  });

  // Heartbeat + self-heal: track the last successful refresh tick and
  // force-exit the process if it hasn't advanced in 5 min. Prevents
  // the zombie state we hit (process alive but event loop wedged on
  // a hung Prisma query — uncaughtException guard kept the process up
  // but supervisors stopped spawning, all 30 recordings silently
  // stalled for 13 h). Scheduled task respawns cleanly on exit.
  let lastTick = Date.now();
  await refreshSupervisors(); lastTick = Date.now();
  // Reentrancy guard: refreshSupervisors awaits `prisma.channel.findMany`
  // and Redis lookups; those can take >5 s under load. Without this
  // guard, the setInterval fires again while the previous tick is
  // still mid-loop. Both invocations pass the `supervisors.has(c.id)`
  // check before either calls `supervisors.set(c.id, sup)` → the same
  // channel gets spawnFFmpeg'd twice (or 8× — 2026-08-18 forensics
  // captured 8 concurrent spawns for one channel in one second).
  let refreshInFlight = false;
  setInterval(async () => {
    if (refreshInFlight) return;
    refreshInFlight = true;
    try {
      await refreshSupervisors();
      lastTick = Date.now();
    } catch (err) {
      log.error({ err }, 'refreshSupervisors threw — will retry next tick');
    } finally {
      refreshInFlight = false;
    }
  }, 5_000);
  setInterval(() => {
    const stale = Date.now() - lastTick;
    if (stale > 300_000) {
      log.error({ staleMs: stale }, 'refreshSupervisors loop wedged >5 min — force-exiting so watchdog can respawn');
      process.exit(1);
    }
  }, 30_000);

  // Age-based recycle — 30 min cap on per-proc memory growth.
  //
  // Graceful `q`-on-stdin was tried 2026-08-20 late but the recording
  // ffmpegs are spawned with `-nostdin` (they don't read stdin at all)
  // so `q` was a no-op → 3 s timeout → hardKill → Windows kill
  // sometimes fails → orphan sweep fires → churn every minute. Not
  // worth the try to save ~2 s of a 60-s segment; hard-kill it and
  // let the next spawn take a clean 60-s cut from there.
  const REC_MAX_AGE_MS = 30 * 60 * 1000;
  setInterval(() => {
    try {
      const now = Date.now();
      const aged = Array.from(supervisors.values())
        .filter((s) => s.proc && !(s as Supervisor & { _stopped?: boolean })._stopped && (now - s.lastRestartAt) > REC_MAX_AGE_MS)
        .sort((a, b) => a.lastRestartAt - b.lastRestartAt);
      const victim = aged[0];
      if (!victim || !victim.proc) return;
      const ageMin = Math.round((now - victim.lastRestartAt) / 60000);
      log.info({ slug: victim.slug, ageMin }, 'recording ffmpeg past MAX_AGE — recycling');
      hardKill(victim.proc);
    } catch (err) { log.warn({ err }, 'rec age-recycle failed'); }
  }, 60_000);

  // Periodically walk EVERY hour dir under EVERY channel and ingest any
  // .mp4 that isn't marked .recorded.
  const { existsSync: _exists, readdirSync } = await import('node:fs');
  // Only the CURRENT and PREVIOUS hour dirs need scanning — anything
  // older either already has a .recorded sidecar (ingested on the last
  // sweep) or was created before the service ever ran and won't ever
  // gain one. The old implementation walked the ENTIRE year/month/day/
  // hour tree every 5 s: on this box that's ~30 d × 24 h × 30 channels
  // ≈ 21 K dirs × (readdir + statSync per .mp4) — the scan never
  // finished, so the `scanning` guard blocked every subsequent tick.
  // Symptom (2026-08-20): 30 recording ffmpegs writing 60 fresh files
  // per channel per hour, but only ONE channel's segments ever landed
  // in the RecordingSegment table. Recordings page showed "0 recordings"
  // + all channels "not-started" because the DB genuinely was empty
  // for the past 12+ hours of otherwise-perfect ffmpeg output.
  function walkChannel(channelId: string): string[] {
    const base = join(RECORDINGS, channelId);
    if (!_exists(base)) return [];
    const now = new Date();
    const prev = new Date(now.getTime() - 3600_000);
    const out: string[] = [];
    for (const when of [prev, now]) {
      const dir = join(
        base,
        String(when.getUTCFullYear()),
        String(when.getUTCMonth() + 1).padStart(2, '0'),
        String(when.getUTCDate()).padStart(2, '0'),
        String(when.getUTCHours()).padStart(2, '0'),
      );
      if (_exists(dir)) out.push(dir);
    }
    return out;
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

// LAST-LINE-OF-DEFENCE. A Prisma error thrown from a timer callback
// or a setInterval-invoked scan can otherwise kill the whole recording
// process and stop ALL 30 channels from recording (this happened at
// ~50 min of stalled recordings). We'd rather log and keep going.
process.on('uncaughtException', (err) => {
  log.error({ err }, 'uncaughtException — keeping process alive');
});
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandledRejection — keeping process alive');
});
