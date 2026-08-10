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
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
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
// 10 = ~60 s window. Was 60 = ~6 min window, which caused hls.js
// to hesitate on where the live edge actually is (default expects
// 6-10 segments in a live playlist). 10 is the standard IPTV live
// setting and lets the player start playing within one segment
// fetch instead of stalling after a single initial segment.
const HLS_LIST_SIZE       = Number(process.env.HLS_LIST_SIZE   ?? 10);
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
    // Bigger input queue between demuxer and encoder/muxer. Default is
    // 8 packets; brief source stalls (IGMP renegotiation, wall PC
    // reconnect, driver interrupt storm) can back-pressure onto the
    // demuxer and cause it to bail. 1024 packets buffer roughly 1-2 s
    // of TS which absorbs those hiccups without visible glitch.
    '-thread_queue_size', '1024',
    '-f', 'mpegts',
    '-i', normaliseUrl(url, kind),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    // Explicitly strip subtitle + data streams (SCTE-35 splice cues,
    // teletext, PSI-P tables). CNN specifically carries these and the
    // browser's Media Source Extensions decoder stalls when it sees a
    // segment with a "text" or "data" track it doesn't recognise —
    // the segments keep loading (visible in DevTools network tab) but
    // video freezes on the last decoded frame. -sn/-dn drops them at
    // the encoder so the HLS segments never contain them.
    '-sn', '-dn',
    // Bigger muxer queue so audio and video can drift briefly without
    // dropping frames. Default 1024 is fine for progressive H.264 but
    // slow-KF sources with SCTE-35 (CNN) sometimes need more headroom.
    '-max_muxing_queue_size', '4096',
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
        // ENCODER QUALITY — the operator verified that layout does not
        // change the wall's ticker sharpness, so the bottleneck is
        // here. Two changes vs. the old "-preset ultrafast + scaler
        // fast_bilinear" config that were both blurring tickers:
        //   1. preset ultrafast -> veryfast
        //      ultrafast disables in-loop deblocking, CABAC and sub-pel
        //      motion — great for CPU but produces visibly blocky text
        //      and mosquito noise around ticker letters. veryfast keeps
        //      all three enabled at ~2 × CPU. On the 56-core box with
        //      12 concurrent encoders and -threads 2 cap this is fine.
        //   2. scale flag fast_bilinear -> lanczos
        //      fast_bilinear is the cheapest scaler and specifically
        //      smears high-contrast horizontal edges (ticker text).
        //      lanczos preserves those edges with a small CPU hit.
        // Resolution kept at 960×540 — bumping higher is thrown away
        // by the wall's 1920×1080 signal budget.
        // Wall encode bumped to 720p — 540p was visibly soft on 1080p
        // tile displays and blurry on 4K wall (2-4x upscale). 720p at
        // 3 Mbps gives crisp text + faces even after wall scaling.
        // CPU cost: ~1.8x per encoder vs 540p, still well under budget.
        const vf = 'yadif=0:-1:0,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2';
        return [
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'veryfast',
          '-tune', 'zerolatency',
          '-profile:v', 'main',
          '-pix_fmt', 'yuv420p',
          '-threads', '2',
          '-b:v',       '3000k',   // 720p at 3 Mbps = broadcast quality
          '-maxrate',   '3800k',
          '-bufsize',   '6000k',
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

  // Delete only the stale live.m3u8 so the stuck-watchdog does not
  // read an ancient mtime. Do NOT purge .ts files here — that added
  // per-launch disk churn (delete all + recreate) which under a
  // chronic-offender restart loop hammered file I/O and starved the
  // kernel non-paged pool → new ffmpeg spawns started failing with
  // ENOMEM. Orphan .ts files from prior runs get cleaned up by the
  // ffmpeg delete_segments flag as segment numbering catches up, and
  // by the periodic housekeeping at service startup.
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
    // Extended cool-down after excessive respawns. A source that has
    // exited 20+ times without ever staying alive long is bad. The
    // sub-second-per-crash storm we saw overnight (92-news restarted
    // 103 × in a few hours) can also exhaust Windows pipe handles and
    // eventually make Node's spawn() itself throw UNKNOWN — which
    // takes the ENTIRE service down. Cap backoff at 5 minutes for
    // channels with runaway crash counts so the parent stays healthy.
    const wait = sup.restarts > 20
      ? 300_000                                      // 5 min for chronic offenders
      : Math.min(30_000, 1000 * Math.pow(2, Math.min(sup.restarts, 5)));
    log.warn(
      { slug: sup.slug, code, sig, restarts: sup.restarts, wait },
      'ffmpeg exited, will restart',
    );
    // Wrap the deferred launch so a spawn() throw does NOT bubble to
    // Node's uncaughtException. Was the root cause of the overnight
    // service death: `Error: spawn UNKNOWN` thrown here after
    // ~150 rapid respawns crashed the entire live-hls process, taking
    // all 30 channels offline.
    setTimeout(() => {
      try { launch(sup); }
      catch (err) {
        log.error({ err, slug: sup.slug, restarts: sup.restarts }, 'launch threw — will retry in 60 s');
        setTimeout(() => { try { launch(sup); } catch (e) { log.error({ e, slug: sup.slug }, 'launch failed twice, giving up until manual restart'); } }, 60_000);
      }
    }, wait);
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
  // A channel is REALLY stuck only if NEITHER the m3u8 nor any segment
  // file has been written in the last 3 min. Just checking m3u8 was
  // too aggressive:
  //   - some sources have GOP > 60 s → first m3u8 takes >120 s to
  //     appear, blowing past the 60 s runway → mass false-kill;
  //   - ffmpeg atomically rewrites the m3u8 (temp + rename), so a
  //     stat during the rename window throws → false-kill;
  //   - our own delete of stale m3u8 in launch() plus a slow first
  //     segment created a spawn→kill→spawn loop that took out all
  //     30 channels roughly every 3-5 h.
  // New logic: FRESH SEGMENTS = ALIVE. If any seg_*.ts was written
  // in the last 30 s, the stream is fine regardless of m3u8 state.
  const STALE_MS = 180_000;
  const RUNWAY_MS = 120_000;        // was 60 000; slow-KF sources need more
  const RECENT_SEG_MS = 30_000;

  for (const sup of supervisors.values()) {
    if (!sup.proc || sup.stop) continue;
    if (Date.now() - sup.lastRestartAt < RUNWAY_MS) continue;

    const outDir = join(HLS_DIR, sup.slug);

    // The authoritative liveness signal: newest .ts segment mtime.
    let newestSegMtime = 0;
    try {
      const files = readdirSync(outDir);
      for (const f of files) {
        if (!f.endsWith('.ts')) continue;
        try { const s = statSync(join(outDir, f)); if (s.mtimeMs > newestSegMtime) newestSegMtime = s.mtimeMs; } catch { /* */ }
      }
    } catch { /* dir might not exist yet — falls through */ }

    if (newestSegMtime > 0 && Date.now() - newestSegMtime < RECENT_SEG_MS) {
      // A fresh segment exists → ffmpeg is happily producing data.
      // Do NOT kill regardless of what the m3u8 file looks like.
      continue;
    }

    // No fresh segment either. Cross-check the m3u8 mtime.
    const mp = join(outDir, 'live.m3u8');
    let m3u8Age = Infinity;
    try { m3u8Age = Date.now() - statSync(mp).mtimeMs; } catch { /* file missing */ }

    if (m3u8Age > STALE_MS) {
      const seg = newestSegMtime === 0 ? 'no-segs' : `${Math.round((Date.now() - newestSegMtime)/1000)}s`;
      log.warn({ slug: sup.slug, m3u8_age_s: m3u8Age === Infinity ? 'missing' : Math.round(m3u8Age/1000), newest_seg: seg }, 'ffmpeg genuinely stuck — killing to restart');
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

  // ONE-TIME housekeeping at service startup: remove every .ts file
  // from every channel dir so we start with a clean slate. Old files
  // from a previous run's counter would otherwise pile up. Runs ONCE
  // (not on every ffmpeg respawn) so it does not thrash disk / kernel
  // pool when a chronic-offender channel restart-loops.
  try {
    for (const chDir of readdirSync(HLS_DIR)) {
      const full = join(HLS_DIR, chDir);
      try {
        for (const f of readdirSync(full)) {
          if (f.endsWith('.ts')) { try { unlinkSync(join(full, f)); } catch { /* */ } }
        }
      } catch { /* */ }
    }
    log.info('startup: cleaned orphan .ts segments across all channel dirs');
  } catch { /* */ }


  // Heartbeat + self-heal: force-exit if the rescan loop wedges >5 min
  // so the scheduled task can respawn cleanly. Guards against the
  // "process alive but event loop stuck" failure mode (Prisma pool
  // hang under uncaughtException guard).
  let lastTick = Date.now();
  await rescan(); lastTick = Date.now();
  setInterval(async () => {
    try { await rescan(); lastTick = Date.now(); }
    catch (err) { log.error({ err }, 'rescan failed'); }
  }, RESCAN_INTERVAL_MS);
  setInterval(() => {
    if (Date.now() - lastTick > 300_000) {
      log.error({ staleMs: Date.now() - lastTick }, 'rescan loop wedged >5 min — force-exiting so watchdog can respawn');
      process.exit(1);
    }
  }, 30_000);

  // Watchdog: kill ffmpegs whose output has genuinely gone quiet.
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
// LAST-LINE-OF-DEFENCE handlers so no single error can take the
// whole live-hls service down and blackhole all 30 channels. Any
// throw from a setTimeout callback or promise rejection is now
// logged instead of killing the process. Fixed the overnight
// blackout where Error: spawn UNKNOWN inside the ffmpeg-exit
// restart timer crashed the parent + left all channels dead
// until manual restart.
process.on('uncaughtException', (err) => {
  log.error({ err }, 'uncaughtException — keeping process alive');
});
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'unhandledRejection — keeping process alive');
});

main().catch((err) => {
  log.error(err);
  process.exit(1);
});
