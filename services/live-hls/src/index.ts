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

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { prisma } from '@cmc/db';

const log = pino({
  transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' },
});

const HLS_DIR             = resolve(process.env.HLS_DIR ?? './data/hls');
// 6 s segments — the ffmpeg HLS muxer waits for the first keyframe
// after this time elapses, so segments naturally align on source IDRs
// (2-4 s on Pakistani feeds). Browser can decode from any segment start.
const HLS_SEGMENT_TIME    = Number(process.env.HLS_SEGMENT_TIME ?? 6);
// 60 segments in playlist = ~6 minutes of history. User accepts high
// latency in exchange for zero stalls; a browser that falls 5 minutes
// behind live edge still finds its segments available.
const HLS_LIST_SIZE       = Number(process.env.HLS_LIST_SIZE   ?? 60);
const FFMPEG              = process.env.FFMPEG_PATH ?? 'ffmpeg';
const RESCAN_INTERVAL_MS  = Number(process.env.LIVE_HLS_RESCAN_MS ?? 30_000);
/** IPv4 address of the NIC that receives the satellite multicast feed.
 *  On the DGPR/CMC server this is 10.51.80.202. Without this, ffmpeg's
 *  udpsrc joins the multicast group on whichever NIC Windows picks by
 *  default — usually the wrong one — and times out with error -5. */
const LOCALADDR           = process.env.LOCALADDR ?? '';
/** Comma-separated slugs whose ffmpeg must skip `-c copy` and always
 *  run through the libx264+deinterlace branch. Two reasons a source
 *  ends up here:
 *    1. Codec probe returned "unknown" so we don't know if `-c copy`
 *       is browser-safe (gtv-news, 365-news, samaa-news have very long
 *       GOPs and don't emit anything ffmpeg can lock on in 2 s).
 *    2. Source is interlaced H.264 (MBAFF/PAFF). ffmpeg happily copies
 *       the stream but Chrome/Edge cannot decode it — the tile stays
 *       black with segments loading. Pakistani HD news channels like
 *       dawn/express/geo/hum/neo broadcast 1080i50 interlaced and hit
 *       this. Transcode with yadif produces progressive H.264 that
 *       every browser plays. */
const FORCE_TRANSCODE_SLUGS = new Set(
  (process.env.LIVE_HLS_FORCE_TRANSCODE ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean),
);

interface Sup {
  channelId:      string;
  slug:           string;
  url:            string;
  kind:           string;
  proc:           ChildProcess | null;
  restarts:       number;
  lastRestartAt:  number;
  stop:           boolean;
  /** Detected source video codec ("h264" / "hevc" / "mpeg2video" / …).
   * Anything other than h264 needs transcoding to H.264 for browser
   * HLS playback. Filled lazily on first spawn. */
  videoCodec?:    string;
  /** True once we've forced this channel onto the transcode command
   * (either because probing showed non-h264 or because copy-mode
   * kept dying / hanging). Sticky for the process lifetime. */
  forceTranscode: boolean;
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
    // Attach reliability params if absent. Big buffers + long timeout —
    // Windows / switch IGMP renegotiations can pause the multicast for
    // 20-40 s at a time, and the old 10 s timeout was making ALL 30
    // ffmpegs exit at exactly the same moment, then restart, then wait
    // for their next keyframe → user sees every tile go to "loading"
    // simultaneously every few minutes. 60 s is long enough to ride
    // through any IGMP hiccup without exiting, but still catches a
    // genuinely dead source within a minute.
    const params: string[] = [];
    // fifo_size = ffmpeg internal buffer (10 MB). buffer_size = kernel
    // SO_RCVBUF (8 MB). With 60 concurrent UDP subscribers on one NIC
    // Windows fails NEW binds at ~800 MB total pinned kernel buffer;
    // 60 * 16 MB tips over, 60 * 8 MB fits.
    if (!u.includes('fifo_size='))         params.push('fifo_size=10000000');
    if (!u.includes('overrun_nonfatal='))  params.push('overrun_nonfatal=1');
    if (!u.includes('timeout='))           params.push('timeout=60000000');
    if (!u.includes('buffer_size='))       params.push('buffer_size=8388608');
    if (!u.includes('reuse='))             params.push('reuse=1');
    if (LOCALADDR && !u.toLowerCase().includes('localaddr=')) {
      params.push(`localaddr=${LOCALADDR}`);
    }
    if (params.length) {
      u = `${u}${u.includes('?') ? '&' : '?'}${params.join('&')}`;
    }
  }
  return u;
}

/**
 * Detect the primary video codec of a UDP MPEG-TS stream by running
 * ffmpeg for a couple of seconds and parsing the "Stream #… Video: …"
 * line from stderr. Cheap (~3 s per channel, once at startup).
 * Returns "h264", "hevc", "mpeg2video", etc. — or null if the probe
 * couldn't lock on to a video stream.
 */
function probeVideoCodec(url: string, kind: string): string | null {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'info',
    '-analyzeduration', '3000000',
    '-probesize', '3000000',
    '-t', '2',
    '-f', 'mpegts',
    '-i', normaliseUrl(url, kind),
    '-f', 'null', '-',
  ];
  const res = spawnSync(FFMPEG, args, { encoding: 'utf8', timeout: 8000 });
  const stderr = res.stderr ?? '';
  const m = stderr.match(/Stream #\d+:\d+[^\n]*Video:\s*([a-z0-9_]+)/i);
  return m ? m[1]!.toLowerCase() : null;
}

function ffArgs(url: string, kind: string, outDir: string, transcodeVideo: boolean, slug: string): string[] {
  const commonInput = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'warning',
    '-fflags', '+discardcorrupt+igndts+genpts',
    '-err_detect', 'ignore_err',
    '-f', 'mpegts',
    '-i', normaliseUrl(url, kind),
    '-map', '0:v:0',
    '-map', '0:a:0?',
  ];

  // Simple by design.
  //   * H.264 sources (26 of the 30 channels) → `-c:v copy`. Zero
  //     transcode cost. Source resolution + bitrate preserved.
  //     Browser plays as-is.
  //   * Non-H.264 (ARY = MPEG-2, occasional HEVC) → one lean libx264
  //     transcode. Native resolution preserved (no scale) so nothing
  //     is downscaled unless the source itself is high-res. ultrafast
  //     preset keeps per-stream cost tiny; only 1-2 channels ever hit
  //     this branch, so total transcode CPU stays negligible.
  const videoArgs = transcodeVideo
    ? (() => {
        // yadif: deinterlace (mode 0 = 1 frame per pair, cheapest).
        // Required for 1080i50 Pakistani HD channels — without it
        // Chrome/Edge won't decode interlaced H.264 even after remux.
        //
        // CNN specifically is 1920×1080 CNNI EMEA HD with SCTE-35 +
        // teletext streams; even multi-threaded ultrafast + yadif
        // hits ~150 % of one core = jittery segments in browser.
        // Downscaling to 1280×720 during encode cuts pixel count 55 %
        // and drops CPU to ~60 %. Tiles on the wall are 240 px wide
        // anyway — zero visual loss from 1080p→720p.
        const isHeavyHDInterlaced = slug === 'cnn';
        const vf = isHeavyHDInterlaced
          ? 'yadif=0:-1:0,scale=1280:720:flags=fast_bilinear'
          : 'yadif=0:-1:0';
        return [
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-profile:v', 'main',
          '-pix_fmt', 'yuv420p',
          '-threads', '0',
          '-b:v', isHeavyHDInterlaced ? '2000k' : '2500k',
          '-maxrate', isHeavyHDInterlaced ? '2500k' : '3000k',
          '-bufsize', isHeavyHDInterlaced ? '4000k' : '5000k',
          '-force_key_frames', `expr:gte(t,n_forced*${HLS_SEGMENT_TIME})`,
        ];
      })()
    : ['-c:v', 'copy'];

  // Audio: always AAC. Browsers stall on MP2 inside HLS.
  //
  // -af aresample=async=1000  → resample-based drift correction. Fixes
  //   CNN-style MP2 audio that arrives with irregular PTS (multi-audio
  //   MPEG-TS + SCTE-35 breaks make the encoder starve for samples
  //   which shows in the browser as "audio atakti"). 1000 samples/s
  //   of stretch tolerance is enough for satellite drift without being
  //   audible.
  const audioArgs = [
    '-c:a', 'aac',
    '-b:a', '96k',
    '-ac', '2',
    '-ar', '48000',
    '-af', 'aresample=async=1000',
  ];

  const hlsArgs = [
    '-avoid_negative_ts', 'make_zero',
    '-f', 'hls',
    '-hls_time', String(HLS_SEGMENT_TIME),
    '-hls_list_size', String(HLS_LIST_SIZE),
    '-hls_flags', 'delete_segments+append_list+omit_endlist+independent_segments',
    '-hls_segment_type', 'mpegts',
    '-hls_allow_cache', '0',
    '-hls_segment_filename', join(outDir, 'seg_%d.ts'),
    join(outDir, 'live.m3u8'),
  ];

  return [...commonInput, ...videoArgs, ...audioArgs, ...hlsArgs];
}

function launch(sup: Sup): void {
  if (sup.stop) return;
  const outDir = join(HLS_DIR, sup.slug);
  mkdirSync(outDir, { recursive: true });

  // Delete any stale live.m3u8 from a prior run. Otherwise the
  // stuck-ffmpeg watchdog reads its ancient mtime (possibly hours
  // old) and, once its 60 s runway expires, thinks the freshly-
  // launched ffmpeg is stuck — killing it. That put us in an
  // endless spawn→kill→spawn loop on cold start. Removing the
  // file forces the watchdog into its "no m3u8 yet" branch, which
  // has the same 60 s runway from launch time only.
  try { unlinkSync(join(outDir, 'live.m3u8')); } catch { /* not there = fine */ }

  // First launch OR previously-forced transcode: pick which command shape.
  // Order of precedence:
  //   1. Slug on the manual force-transcode list (LIVE_HLS_FORCE_TRANSCODE)
  //      → transcode, skip codec probe entirely (probe costs 2-8 s
  //      and these channels are known problematic anyway).
  //   2. Codec probe: non-h264 → transcode; h264 or unknown → copy.
  //      Non-h264 sources can't be `-c copy`'d for browser HLS
  //      (Chrome/Edge don't decode MPEG-2 / HEVC inside HLS).
  if (sup.videoCodec === undefined) {
    if (FORCE_TRANSCODE_SLUGS.has(sup.slug)) {
      sup.videoCodec = 'forced';
      sup.forceTranscode = true;
      log.info({ slug: sup.slug }, 'slug in LIVE_HLS_FORCE_TRANSCODE - transcoding');
    } else {
      const codec = probeVideoCodec(sup.url, sup.kind);
      sup.videoCodec = codec ?? 'unknown';
      if (codec && codec !== 'h264') {
        sup.forceTranscode = true;
        log.info({ slug: sup.slug, codec }, 'non-h264 source - will transcode to H.264');
      } else {
        log.info({ slug: sup.slug, codec: codec ?? 'unknown' }, 'source codec');
      }
    }
  }

  const args = ffArgs(sup.url, sup.kind, outDir, sup.forceTranscode, sup.slug);
  const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  sup.proc = proc;
  sup.lastRestartAt = Date.now();
  log.info({ slug: sup.slug, transcode: sup.forceTranscode }, 'ffmpeg started');

  proc.stderr?.on('data', (buf: Buffer) => {
    const line = buf.toString().trim();
    if (line && !/^size=/.test(line) && !/^\s*frame=/.test(line)) {
      log.debug({ slug: sup.slug }, line.slice(0, 300));
    }
  });

  proc.on('exit', (code, sig) => {
    sup.proc = null;
    if (sup.stop) return;
    sup.restarts += 1;
    const wait = Math.min(30_000, 1000 * Math.pow(2, Math.min(sup.restarts, 5)));
    log.warn(
      { slug: sup.slug, code, sig, restarts: sup.restarts, wait },
      'ffmpeg exited, will restart',
    );
    setTimeout(() => launch(sup), wait);
  });
}

/**
 * Stuck-ffmpeg watchdog. An ffmpeg can look alive (process running,
 * no exit code) while producing zero output for hours — happens when
 * the source sends PSI tables but no keyframes, so ffmpeg blocks
 * waiting for something it can serialise. Detects staleness via the
 * live.m3u8 mtime and force-kills so the exit handler respawns.
 *
 * On a kill, if we're not already in transcode mode, promote the
 * channel to transcode — a stream that hangs `-c copy` for minutes
 * often has malformed NALs that libx264 re-encoding cleans up.
 */
function checkStuckFFmpegs(): void {
  // Loose threshold: with `-c copy` and 6 s segments the m3u8 typically
  // updates every 6-12 s. 3 min of no update = source has genuinely
  // gone quiet; anything shorter risks killing a stream that is just
  // waiting on the next keyframe of a slow-GOP source.
  const STALE_MS = 180_000;
  for (const sup of supervisors.values()) {
    if (!sup.proc || sup.stop) continue;
    // Give the ffmpeg 60 s of runway after (re)launch before judging.
    if (Date.now() - sup.lastRestartAt < 60_000) continue;
    const mp = join(HLS_DIR, sup.slug, 'live.m3u8');
    try {
      const st = statSync(mp);
      if (Date.now() - st.mtimeMs > STALE_MS) {
        log.warn({ slug: sup.slug, stale_ms: Date.now() - st.mtimeMs }, 'ffmpeg stuck — killing to restart');
        try { sup.proc.kill('SIGKILL'); } catch { /* noop */ }
      }
    } catch {
      // No m3u8 yet AND ffmpeg has been running for >60 s → probably
      // stuck before it wrote the first playlist. Kill it.
      log.warn({ slug: sup.slug }, 'no m3u8 written yet — killing to restart');
      try { sup.proc.kill('SIGKILL'); } catch { /* noop */ }
    }
  }
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
        proc: null, restarts: 0, lastRestartAt: 0, stop: false, forceTranscode: false };
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
  // Watchdog: kill ffmpegs whose live.m3u8 hasn't updated in >60 s.
  // Every 15 s so we catch a stuck ffmpeg within ~75 s of hanging.
  setInterval(() => {
    try { checkStuckFFmpegs(); } catch (err) { log.warn({ err }, 'stuck-check failed'); }
  }, 15_000);
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
