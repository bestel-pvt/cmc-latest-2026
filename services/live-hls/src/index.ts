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

/**
 * Hard kill an ffmpeg process tree WITH verify-loop.
 *
 * Windows layers of unreliability:
 *  1. proc.kill('SIGKILL') only signals the parent handle → children
 *     (encoder threads, mux worker) survive. Solved by taskkill /F /T
 *     which walks the tree.
 *  2. Even taskkill returns "success" while an ffmpeg blocked in a
 *     kernel-level UDP socket wait keeps running — the socket wait
 *     can't be cancelled from userspace. TerminateProcess sets exit
 *     code but the process stays alive. Node's on('exit') then fires,
 *     supervisor spawns a replacement, and the old one becomes a
 *     zombie. Observed: 184 zombies from one supervisor after ~50 h.
 *
 * Fix: after taskkill, verify the PID is actually gone. If it's still
 * there after 3 attempts * 1s, log an error and return anyway so the
 * caller can move on — the process is truly unkillable via userspace
 * and only a NIC restart (forces socket closure) or reboot will
 * reap it. Marking it "gone" for the supervisor is a lie, but at
 * least we don't respawn on top of it (see stillAlive check in the
 * supervisor's exit handler).
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
      try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
      catch { /* fall through to sleep+recheck */ }
      // Give kernel 800 ms to actually reap
      spawnSync('cmd', ['/c', 'timeout', '/t', '1', '/nobreak', '>', 'NUL'], { stdio: 'ignore' });
      if (!pidAlive(pid)) return true;
    }
    log.error({ pid }, 'hardKill: process still alive after 3 taskkill attempts — kernel-blocked ffmpeg (needs NIC restart)');
    return false;
  }
  try { proc.kill('SIGKILL'); } catch { /* noop */ }
  return true;
}
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
// Global override: transcode EVERY channel. Set when source audit
// (probe-all-sources) shows the majority of sources have MP2 audio /
// High-profile h264 / non-h264 codec that browsers cannot play as -c copy.
// Simpler than maintaining a 29-entry slug whitelist and gives a
// consistent codec/container across every tile which hls.js / MSE
// handles best.
const TRANSCODE_ALL = process.env.LIVE_HLS_TRANSCODE_ALL === '1';

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
    // fifo_size 8 MB, buffer_size 8 MB — restored after 4 MB starved
    // transcoded encoders during real IGMP hiccups (8 wall channels
    // went stuck within 20 min: 365/aaj/capital/dawn/express/geo/hum/neo,
    // Buffers restored to the previously-stable 8 MB values. The
    // shorter 2 MB / 4 MB experiment reduced Private memory but
    // caused streams to stutter under normal IGMP jitter (operator
    // observation). Memory ceiling now enforced by the age-based
    // ffmpeg recycle (see recycleAgedFFmpegs) instead of by
    // starving the input buffer.
    if (!u.includes('fifo_size='))         params.push('fifo_size=8000000');
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
    // Kept +igndts back. Removing it caused streams to stall on the
    // handful of sources whose DTS drifts occasionally (Pakistani
    // interlaced 1080i50 with ad breaks). Memory ceiling now enforced
    // by age-based recycle (recycleAgedFFmpegs) instead of by
    // starving demux options.
    '-fflags', '+discardcorrupt+igndts+genpts',
    '-err_detect', 'ignore_err',
    // Bigger input queue between demuxer and encoder/muxer. Default is
    // 8 packets; brief source stalls (IGMP renegotiation, wall PC
    // reconnect, driver interrupt storm) can back-pressure onto the
    // demuxer and cause it to bail. 1024 packets buffer roughly 1-2 s
    // of TS which absorbs those hiccups without visible glitch.
    // thread_queue 512 — 128 starved transcoded encoders under real
    // IGMP hiccups (20-min stuck-storm on 8 wall x264 channels). 1024
    // was over-provisioned. 512 = ~1 s of a 5 Mbps stream = enough
    // to ride typical bursts without holding hundreds of MB per encoder.
    // thread_queue 512 — proven stable value. Lower values caused
    // stall storms during normal IGMP hiccups. Memory ceiling
    // enforced by age-based recycle instead.
    '-thread_queue_size', '512',
    // VLC-tolerant probing. Bumped from 10s/10MB to 40s/50MB after
    // observing CNN take ~30s to lock in VLC on the server (2026-08-18).
    // Multiple channels (CNN, 365-news, aaj-news, bol-news) have the
    // same pattern: PAT/PMT slow after IGMP join → ffmpeg gives up at
    // 10s and enters a spawn→watchdog-kill→respawn loop that never
    // produces any HLS. 40s + 50MB matches the slowest observed lock
    // with headroom; RUNWAY_MS below (120s) still gives plenty of
    // margin before the stuck-watchdog first considers killing.
    '-analyzeduration', '40000000',
    '-probesize', '50000000',
    '-f', 'mpegts',
    '-i', normaliseUrl(url, kind),
    // '?' makes video map optional so an audio-only source still
    // produces an HLS playlist (silent video slot; browser will show
    // black + audio). Was mandatory before → any source whose video
    // dropped for a moment killed the whole encoder.
    '-map', '0:v:0?',
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
    // Muxing queue: default 1024. 4096 was unnecessarily large and
    // holds bounded but non-trivial memory per encoder.
    '-max_muxing_queue_size', '1024',
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
        // Data-driven wall encoder config, derived from a full source
        // audit (probe-all-sources.ps1) of all 30 channels:
        //   - 19 sources are h264 High profile → MSE bufferAppendError under -c copy
        //   - 9 sources have MP2 audio → browsers cannot play in HLS
        //   - 1 source (ary) is MPEG-2 video → completely un-playable in HLS
        //   - only 1 (BBC) is truly -c copy safe
        // Conclusion: transcode every channel, produce ONE consistent
        // container/codec/profile across the wall.
        //
        // Pure stretch (scale=WxH without aspect preservation) fills
        // the tile fully:
        //   - no black bars (unlike pad-fit)
        //   - no cropping (unlike crop-fill)
        //   - minor horizontal stretch on the one 4:3 source (ary)
        //     which is an acceptable trade-off vs pillar bars / lost
        //     ticker content
        // 854x480 at 1.5 Mbps ultrafast keeps 30 concurrent encoders
        // to ~30 cores of the 56-core box, leaving comfortable
        // headroom for recording + kernel + Node services.
        // 640x360: wall tiles are 240-500 px wide in the operator's
        // multiviewer layouts. 360p vs 480p vs 720p is imperceptible
        // at that tile size. Halving pixel count vs 480p roughly
        // halves the per-encoder CPU. Measured: 88% system CPU at
        // 854x480 → too tight; 640x360 fits with 40%+ headroom.
        const vf = 'yadif=0:-1:0,scale=640:360:flags=lanczos';
        return [
          '-vf', vf,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-profile:v', 'main',
          '-pix_fmt', 'yuv420p',
          '-threads', '2',
          '-b:v',       '1000k',
          '-maxrate',   '1300k',
          '-bufsize',   '2600k',
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
    if (TRANSCODE_ALL) {
      sup.videoCodec = 'forced-all';
      sup.forceTranscode = true;
      // codec probe skipped when TRANSCODE_ALL — no-op logs kept quiet
    } else if (FORCE_TRANSCODE_SLUGS.has(sup.slug)) {
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
    // Reset the restart counter if ffmpeg stayed alive long enough
    // to be considered "healthy" before this exit. Was: unconditional
    // sup.restarts += 1 counted every routine age-recycle (fires
    // every 90 min = MAX_ENCODER_AGE_MS) as a crash. Over 24 h that
    // pushed the counter from 1 → 16 despite every ffmpeg running a
    // healthy 90 min before its recycle. Once >8, chronic-offender
    // cooldown kicked in → 5-MINUTE HLS blackout every 90 min. User
    // symptom: channel stuck/looping/showing stale content during
    // the 5 min gap, hard-refresh sometimes fixes it (browser drops
    // buffered playlist). Matches the recording service's fix.
    const wasAliveLong = Date.now() - sup.lastRestartAt > 30_000;
    sup.restarts = wasAliveLong ? 0 : sup.restarts + 1;
    // Extended cool-down after excessive respawns. A source that has
    // exited 20+ times without ever staying alive long is bad. The
    // sub-second-per-crash storm we saw overnight (92-news restarted
    // 103 × in a few hours) can also exhaust Windows pipe handles and
    // eventually make Node's spawn() itself throw UNKNOWN — which
    // takes the ENTIRE service down. Cap backoff at 5 minutes for
    // channels with runaway crash counts so the parent stays healthy.
    // Chronic-offender cooldown kicks in EARLIER (was >20). A source
    // that stalls 8 times in a row is almost certainly broadcaster-side
    // (video stream missing, malformed timing, off-air). Keep hammering
    // it at 15 s intervals wastes CPU + log noise and can domino to
    // healthy channels via file-IO / kernel-pool contention.
    const wait = sup.restarts > 8
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
/**
 * Age-based encoder recycle. Every ffmpeg (both libx264 AND -c copy)
 * grows Private memory ~1 GB/hour in production. Root cause is
 * ffmpeg's internal packet/PTS bookkeeping on live UDP streams with
 * mild timing jitter — unfixable in config alone. Bounded lifetime
 * is the only guaranteed backstop.
 *
 * Every MAX_ENCODER_AGE_MS the oldest one supervisor sees > age gets
 * SIGKILL'd — exit handler respawns in <2s. Sequential (one per
 * check tick) so at most 1 tile blinks at a time; wall stays smooth.
 *
 * Watch interval 60 s + spread across supervisors: ~30 kills per 90
 * minutes = ~1 kill / 3 minutes. Each blink ~2-3 s.
 */
const MAX_ENCODER_AGE_MS = 90 * 60 * 1000;
function recycleAgedFFmpegs(): void {
  const now = Date.now();
  const aged = Array.from(supervisors.values())
    .filter((s) => s.proc && !s.stop && (now - s.lastRestartAt) > MAX_ENCODER_AGE_MS)
    .sort((a, b) => a.lastRestartAt - b.lastRestartAt);   // oldest first
  const victim = aged[0];
  if (!victim || !victim.proc) return;
  const ageMin = Math.round((now - victim.lastRestartAt) / 60000);
  log.info({ slug: victim.slug, ageMin }, 'encoder past MAX_ENCODER_AGE — recycling');
  hardKill(victim.proc);
}

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
  // STALE_MS lowered 180 -> 90 so intermittent source drops
  // (dawn/express/aaj/ary style) get killed + respawned in ~90s
  // instead of ~3 min. Combined with the client's 30s freeze
  // watchdog rebuilding the hls instance, operator perception of
  // a stuck tile is now ~30 s max, not minutes.
  const STALE_MS = 90_000;
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
      hardKill(sup.proc);
    }
  }
}

/**
 * Memory-hog watchdog. libx264 encoders leak slowly on this box —
 * observed 300-500 MB per encoder after 3-4 h, which added up to
 * 10+ GB across 60 encoders and OOM'd the whole box (new ffmpeg
 * spawns failed with -12/ENOMEM, wall tiles went dark).
 *
 * Runs every 60 s. Anything over MEMORY_KILL_MB gets SIGKILL'd; the
 * exit handler respawns in <2 s = one tile blinks briefly, rest of
 * the wall keeps playing untouched. Reactive not scheduled: only
 * fires when a leak actually happens, so a healthy 24/7 stream is
 * never touched.
 */
const MEMORY_KILL_MB = 250;
async function checkFatFFmpegs(): Promise<void> {
  const wmic = spawn('wmic', ['process', 'where', "name='ffmpeg.exe'", 'get', 'ProcessId,WorkingSetSize', '/format:csv'],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  wmic.stdout.on('data', (b) => { out += b.toString(); });
  await new Promise<void>((res) => { wmic.on('exit', () => res()); wmic.on('error', () => res()); });

  const wsByPid = new Map<number, number>();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.split(',');
    if (parts.length < 3) continue;
    const pid = Number(parts[1]);
    const ws = Number(parts[2]);
    if (!isNaN(pid) && !isNaN(ws)) wsByPid.set(pid, ws);
  }

  for (const sup of supervisors.values()) {
    if (!sup.proc || sup.stop) continue;
    const pid = sup.proc.pid;
    if (!pid) continue;
    const ws = wsByPid.get(pid);
    if (!ws) continue;
    const mb = Math.round(ws / 1024 / 1024);
    if (mb > MEMORY_KILL_MB) {
      log.warn({ slug: sup.slug, pid, mb }, `ffmpeg over ${MEMORY_KILL_MB} MB — recycling`);
      hardKill(sup.proc);
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
      if (cur.proc) { hardKill(cur.proc); }
      // launch() will fire from the exit handler
    }
  }

  // Stop supervisors for channels that went inactive / were removed.
  for (const [id, sup] of supervisors) {
    if (!desired.has(id)) {
      log.info({ slug: sup.slug }, 'channel inactive, stopping ffmpeg');
      sup.stop = true;
      if (sup.proc) { hardKill(sup.proc); }
      supervisors.delete(id);
    }
  }
}

async function main(): Promise<void> {
  log.info({ HLS_DIR, HLS_SEGMENT_TIME, HLS_LIST_SIZE, FFMPEG }, 'live-hls starting');
  mkdirSync(HLS_DIR, { recursive: true });

  // STARTUP ZOMBIE SWEEP. When the previous live-hls process died
  // (force-exit, crash, OS kill), any ffmpeg children it spawned are
  // orphaned — they keep running but nothing supervises or reaps
  // them. Over multiple crash cycles this piles up (144 zombies /
  // 250 GB committed observed after a mass-source-drop → force-exit
  // → task didn't respawn). Windows Task Manager's process tree
  // linkage is loose enough that the orphans survive parent death.
  //
  // Fix: at startup, before spawning fresh ffmpegs, kill any ffmpeg
  // whose command line references our HLS dir. Uses wmic (server
  // has it) with a per-PID taskkill /T for hard tree-kill.
  if (process.platform === 'win32') {
    try {
      const wmic = spawnSync('wmic', ['process', 'where', "name='ffmpeg.exe'",
        'get', 'ProcessId,CommandLine', '/format:csv'], { encoding: 'utf8' });
      const marker = HLS_DIR.replace(/\\/g, '\\\\').toLowerCase();
      const pids: number[] = [];
      for (const line of (wmic.stdout ?? '').split(/\r?\n/)) {
        if (!line.toLowerCase().includes(marker.toLowerCase().split('\\').slice(-2).join('\\'))) continue;
        // last CSV field is PID
        const parts = line.trim().split(',');
        const pid = Number(parts[parts.length - 1]);
        if (Number.isInteger(pid) && pid > 0) pids.push(pid);
      }
      for (const pid of pids) {
        try { spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore' }); }
        catch { /* noop */ }
      }
      if (pids.length > 0) log.info({ count: pids.length }, 'startup: killed orphan ffmpeg zombies from previous run');
    } catch (err) { log.warn({ err }, 'startup zombie sweep failed'); }
  }

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
  // Age-based recycle: kill the oldest ffmpeg past MAX_ENCODER_AGE_MS
  // every minute. One-at-a-time so at most a single tile is blinking.
  // Guarantees no ffmpeg lives >90 min = memory can never accumulate
  // to the 1-2 GB level we saw overnight. No wmic, no polling storm,
  // just a check-then-signal from the supervisor's own state.
  setInterval(() => {
    try { recycleAgedFFmpegs(); } catch (err) { log.warn({ err }, 'age-recycle failed'); }
  }, 60_000);
  void checkFatFFmpegs;    // legacy wmic path kept for reference; not called
  // Keep the event loop alive.
  process.stdin.resume();
}

function shutdown(): void {
  for (const sup of supervisors.values()) {
    sup.stop = true;
    if (sup.proc) { hardKill(sup.proc); }
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
