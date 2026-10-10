import type { FastifyPluginAsync } from 'fastify';
import { createReadStream, statSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const q = (req.query as { channelId?: string; from?: string; to?: string; limit?: string }) ?? {};
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to   = q.to   ? new Date(q.to)   : new Date();

    return app.prisma.recordingSegment.findMany({
      where: {
        ...(q.channelId ? { channelId: q.channelId } : {}),
        startedAt: { gte: from, lte: to },
      },
      include: { channel: { select: { id: true, name: true, slug: true } } },
      orderBy: { startedAt: 'desc' },
      take: q.limit ? Math.min(Number(q.limit), 5000) : 500,
    });
  });

  /**
   * GET /api/recordings/status — live per-channel recording status.
   *
   * Recording flag alone isn't enough: recordingEnabled=true could
   * mean the ffmpeg died silently. So for every recording-enabled
   * channel we walk today's dir on disk and check the mtime of the
   * newest .mp4. Fresh (<90 s) = actively writing. 90 s-5 min = idle
   * (segment IO paused, source hiccup). >5 min = stalled/failed.
   *
   * This is O(active-channels), typically 30 stats. ~10 ms total.
   */
  app.get('/status', async () => {
    // OLD implementation walked D:\cmc\recordings\<channelId>\**\*.mp4
    // synchronously for every channel to find the newest segment. On
    // this box that means ~30 channels × hundreds of thousands of .mp4
    // files with statSync each — measured 25 s in production 2026-08-20,
    // causing the dashboard "Recording status" tile to hang until the
    // 30 s browser timeout fired. Everything the FS walk was after is
    // already in the RecordingSegment table indexed by (channelId,
    // startedAt); one Prisma query returns the same result in <50 ms.
    const channels = await app.prisma.channel.findMany({
      where: { recordingEnabled: true, active: true },
      select: { id: true, name: true, slug: true },
    });
    // Pull the newest RecordingSegment row per channel with a single
    // GROUP-BY-style query. Prisma has no native distinct-on so we
    // fetch the last-24h window (small) and reduce in JS — this is
    // still O(N segments in 24h) not O(N total files on disk).
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);
    const recent = await app.prisma.recordingSegment.findMany({
      where: { channelId: { in: channels.map((c) => c.id) }, startedAt: { gte: dayAgo } },
      select: { channelId: true, startedAt: true, durationMs: true, sizeBytes: true },
      orderBy: { startedAt: 'desc' },
    });
    const newestByCh = new Map<string, { at: number; size: number }>();
    for (const s of recent) {
      if (newestByCh.has(s.channelId)) continue;
      const endedAt = s.startedAt.getTime() + s.durationMs;
      newestByCh.set(s.channelId, { at: endedAt, size: Number(s.sizeBytes ?? 0) });
    }
    const now = Date.now();
    return channels.map((c) => {
      const n = newestByCh.get(c.id);
      if (!n) return { ...c, status: 'not-started' as const, sizeBytes: 0, lastWriteAt: null, ageSec: null };
      const ageSec = Math.round((now - n.at) / 1000);
      const status: 'recording' | 'idle' | 'failed' | 'not-started' =
        ageSec < 90 && n.size > 4096 ? 'recording' :
        ageSec < 90                  ? 'idle'      :
        ageSec < 300                 ? 'idle'      :
                                       'failed';
      return {
        ...c, status,
        sizeBytes: n.size,
        lastWriteAt: new Date(n.at).toISOString(),
        ageSec,
      };
    });
  });

  /**
   * Group contiguous 60 s segments into logical "sessions" (one row per
   * recording that the operator started/stopped, not one per segment).
   * A gap ≥ 3 minutes ends a session. Response shape suits the
   * Recordings page's default all-channels list.
   */
  app.get('/sessions', async (req) => {
    const q = (req.query as { channelId?: string; from?: string; to?: string; limit?: string }) ?? {};
    // Default window narrowed from 30 d → 24 h (2026-08-20). With
    // ~30 channels × 60 s segments × 30 d = ~1.3 M rows the default
    // query was pulling several hundred MB into Node memory and
    // timing out at 30 s. If the operator needs older data they
    // pick from the date range control (which sets q.from/q.to).
    const from = q.from ? new Date(q.from) : new Date(Date.now() - 24 * 3600 * 1000);
    const to   = q.to   ? new Date(q.to)   : new Date();
    // OVERLAP filter, not strict-started-in-window.
    // Otherwise a "last 10 minutes" filter on an ongoing 30-min session
    // that started 15 min ago returns nothing — the SESSION's startedAt
    // is 15 min ago, so a strict `startedAt >= from` filter excludes it.
    // What the operator actually wants: any segment whose
    // [startedAt, startedAt+duration] overlaps the picked window.
    // Prisma doesn't do arithmetic in where clauses, so we widen the
    // startedAt >= bound by one segment length and post-filter to keep
    // the query planner-friendly.
    const widenMs = (Number(process.env.RECORDING_SEGMENT_SECONDS ?? 60) + 5) * 1000;
    // Pull ONLY the columns we need for the group-by. Was including the
    // full RecordingSegment row + a joined Channel object per row; on a
    // 24-hour window with 30 channels that's 115K+ rows × ~1KB = 100+ MB
    // pulled through Prisma and materialised into JS objects, blocking
    // the Node event loop for tens of seconds on JSON.stringify and
    // freezing every other request (login included). Reported 2026-09-11
    // as recurring "api hangs, login times out" — trace showed the
    // sessions call in flight when everything froze.
    // Channel names are fetched once for the small set of channels
    // referenced by these segments, then attached in-memory.
    const channelsPromise = app.prisma.channel.findMany({
      select: { id: true, name: true, slug: true },
      ...(q.channelId ? { where: { id: q.channelId } } : {}),
    });
    const segments = (await app.prisma.recordingSegment.findMany({
      where: {
        ...(q.channelId ? { channelId: q.channelId } : {}),
        startedAt: { gte: new Date(from.getTime() - widenMs), lte: to },
      },
      select: { id: true, channelId: true, startedAt: true, durationMs: true, sizeBytes: true },
      orderBy: [{ channelId: 'asc' }, { startedAt: 'asc' }],
    })).filter((s) => {
      const segEnd = s.startedAt.getTime() + s.durationMs;
      return segEnd >= from.getTime() && s.startedAt <= to;
    });
    const channels = await channelsPromise;
    const channelById = new Map(channels.map((c) => [c.id, c]));
    // Bucket into sessions by (channelId, gap ≥ 3 min)
    const GAP_MS = 3 * 60 * 1000;
    interface Session {
      id: string;
      channelId: string; channel: { id: string; name: string; slug: string };
      startedAt: Date; endedAt: Date;
      durationMs: number; sizeBytes: bigint;
      segmentCount: number;
      firstSegmentId: string; lastSegmentId: string;
    }
    const sessions: Session[] = [];
    let cur: Session | null = null;
    for (const s of segments) {
      const end = new Date(s.startedAt.getTime() + s.durationMs);
      if (!cur || cur.channelId !== s.channelId ||
          (s.startedAt.getTime() - cur.endedAt.getTime()) > GAP_MS) {
        const ch = channelById.get(s.channelId) ?? { id: s.channelId, name: s.channelId, slug: s.channelId };
        cur = {
          id: `sess-${s.id}`,
          channelId: s.channelId, channel: ch,
          startedAt: s.startedAt, endedAt: end,
          durationMs: s.durationMs, sizeBytes: BigInt(s.sizeBytes ?? 0n),
          segmentCount: 1,
          firstSegmentId: s.id, lastSegmentId: s.id,
        };
        sessions.push(cur);
      } else {
        cur.endedAt = end;
        cur.durationMs = cur.endedAt.getTime() - cur.startedAt.getTime();
        cur.sizeBytes = cur.sizeBytes + BigInt(s.sizeBytes ?? 0n);
        cur.segmentCount += 1;
        cur.lastSegmentId = s.id;
      }
    }
    sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const limit = q.limit ? Math.min(Number(q.limit), 2000) : 500;
    return sessions.slice(0, limit);
  });

  // Days with recordings (calendar heatmap)
  app.get('/days', async (req, reply) => {
    const { channelId, year, month } = (req.query as { channelId?: string; year?: string; month?: string }) ?? {};
    if (!channelId || !year || !month) return reply.badRequest();
    const start = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
    const end   = new Date(Date.UTC(Number(year), Number(month),     1));
    const rows = await app.prisma.$queryRaw<Array<{ day: Date; count: bigint }>>`
      SELECT date_trunc('day', "startedAt") AS day, COUNT(*)::bigint AS count
      FROM "RecordingSegment"
      WHERE "channelId" = ${channelId} AND "startedAt" >= ${start} AND "startedAt" < ${end}
      GROUP BY 1 ORDER BY 1`;
    return rows.map((r) => ({ day: r.day, count: Number(r.count) }));
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const seg = await app.prisma.recordingSegment.findUnique({ where: { id } });
    if (!seg) return reply.notFound();
    return seg;
  });

  /**
   * Concatenate every segment overlapping [from, to] for a channel into
   * ONE playable MP4 and stream it back. The whole session shows as a
   * single video with a proper scrubber — no visible "segments" in the UI.
   *
   * Caching: the concatenated file is written to /tmp/demp-sessions and
   * keyed by (channelId, from, to). First request builds it with
   * `ffmpeg -f concat -c copy` (fast — stream copy, ~1 s per hour of
   * content); subsequent requests stream from the cache.
   */
  const SESSION_CACHE = join(tmpdir(), 'demp-sessions');
  mkdirSync(SESSION_CACHE, { recursive: true });

  const buildLocks = new Map<string, Promise<string | null>>();

  // Semaphore: cap concurrent download-transcodes so the API stays
  // responsive to /hls/ + /sessions polls while a fleet of users
  // clicks Download. Beyond this, requests wait their turn (client
  // sees a longer "preparing" spinner but the page keeps loading).
  // 2 is the sweet spot on a 56-core box: two ultrafast 640x360
  // encoders occupy ~2 cores, leaving the other 54 for wall
  // encoders + Node + kernel.
  const DL_MAX_CONCURRENT = 2;
  let dlInFlight = 0;
  const dlQueue: Array<() => void> = [];
  const dlAcquire = () => new Promise<void>((res) => {
    if (dlInFlight < DL_MAX_CONCURRENT) { dlInFlight++; return res(); }
    dlQueue.push(() => { dlInFlight++; res(); });
  });
  const dlRelease = () => {
    dlInFlight--;
    const next = dlQueue.shift();
    if (next) next();
  };

  /** Quick "does this MP4 have a readable moov atom" probe. Recorder
   * kills / crashes leave zero-length or moov-less files; the concat
   * demuxer stops dead on those, so we skip them.
   *
   * ffprobe isn't part of every ffmpeg build (the Windows build shipped
   * on the CMC server has ffmpeg.exe + ffplay.exe but no ffprobe). When
   * the binary can't be spawned we return TRUE and let downstream
   * playback decide — the recorder only writes a DB row after a segment
   * is fully closed and its SHA-256 is captured, so a row alone is a
   * strong "this was a valid file" signal. */
  async function isPlayable(path: string): Promise<boolean> {
    return new Promise((resolve) => {
      const ff = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name,duration', '-of', 'csv', path,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      ff.stdout.on('data', (b) => { out += b.toString(); });
      ff.on('exit', (code) => resolve(code === 0 && out.trim().length > 0));
      ff.on('error', () => resolve(true));
    });
  }

  /** Estimate a segment's playable duration from its file mtime relative
   *  to `startedAt`. Anchored to a value the OS actually records — the
   *  ffmpeg -i banner Duration is unreliable on our fragmented-mp4
   *  segments (empty_moov leaves mvhd carrying multi-minute nonsense;
   *  a real 11-sec segment probed as 4:14 on 2026-09-04 and poisoned
   *  the session playlist with 42 phantom sub-segments).
   *  Range-guarded 1 s – 15 min. Returns null when out of range or
   *  the file is gone. */
  function estimateSegmentDurationMs(path: string, startedAtMs: number): number | null {
    try {
      const mtime = statSync(path).mtimeMs;
      const ms = Math.round(mtime - startedAtMs);
      if (ms >= 1000 && ms <= 900_000) return ms;
      return null;
    } catch { return null; }
  }

  async function buildSessionMp4(channelId: string, from: Date, to: Date): Promise<string | null> {
    // Ensure cache dir exists on every call — a manual /tmp cleanup
    // (or a systemd tmpfiles reboot) can wipe it out from under us.
    mkdirSync(SESSION_CACHE, { recursive: true });

    const key = createHash('sha1').update(`${channelId}:${from.getTime()}:${to.getTime()}`).digest('hex').slice(0, 20);
    const outPath = join(SESSION_CACHE, `${key}.mp4`);
    if (existsSync(outPath) && statSync(outPath).size > 1024) return outPath;
    if (buildLocks.has(key)) return buildLocks.get(key)!;

    const p = (async (): Promise<string | null> => {
      const segments = await app.prisma.recordingSegment.findMany({
        where: {
          channelId,
          startedAt: { gte: new Date(from.getTime() - 5 * 60 * 1000), lte: to },
        },
        orderBy: { startedAt: 'asc' },
      });
      const covering = segments.filter((s) => {
        const end = new Date(s.startedAt.getTime() + s.durationMs);
        return end > from && s.startedAt < to;
      });
      if (covering.length === 0) return null;

      // Filter out corrupt / half-written segments — concat demuxer
      // bails on the first bad file and stops before the rest.
      // Dedup HEAVILY overlapping segments (>= 5 s). Same rationale as
      // the session.m3u8 handler — small (1-2 s) overlaps between
      // consecutive segments from a single ffmpeg are normal jitter
      // from keyframe-aligned splits and MUST be kept.
      const dedupedCov: typeof covering = [];
      for (const s of covering) {
        const prev = dedupedCov[dedupedCov.length - 1];
        if (prev) {
          const prevEnd = prev.startedAt.getTime() + prev.durationMs;
          const overlapMs = prevEnd - s.startedAt.getTime();
          if (overlapMs >= 5000) continue;
        }
        dedupedCov.push(s);
      }
      const playable: string[] = [];
      for (const s of dedupedCov) {
        if (!existsSync(s.path)) continue;
        if (statSync(s.path).size < 4096) continue;
        if (await isPlayable(s.path)) playable.push(s.path);
      }
      if (playable.length === 0) return null;

      const listPath = join(SESSION_CACHE, `${key}.txt`);
      const lines = playable.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n');
      writeFileSync(listPath, lines);

      // Download preserves SOURCE quality. Recording segments are
      // stored -c copy at native bitrate/resolution, so a plain concat
      // -c copy pass here means the download is byte-for-byte identical
      // to the source frames — no re-encode, no quality loss, no
      // compress-below-source (which was the 2026-08-20 regression:
      // 1.3 MB source segment → 975 KB downloaded → operator called
      // it "totally ghalat").
      //
      // If concat -c copy fails (mismatched codecs across segments,
      // e.g. spans an old-transcoded window + new native), we fall
      // back to a CRF re-encode at the SOURCE resolution — visually
      // indistinguishable from the input, size adapts to content,
      // never dumbly downscaled.
      const runFf = async (args: string[]): Promise<string | null> => {
        return await new Promise<string | null>((resolve, reject) => {
          const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
          if (ff.pid) {
            try { os.setPriority(ff.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
          }
          let tail = '';
          ff.stderr?.on('data', (b) => {
            tail += b.toString();
            if (tail.length > 4000) tail = tail.slice(-2000);
          });
          ff.on('exit', (code) => code === 0
            ? resolve(null)
            : reject(new Error(`ffmpeg exit ${code}: ${tail.slice(-800) || '(no stderr)'}`)));
          ff.on('error', reject);
        });
      };
      // Recording download: pure-stretch to 854x480 (matches ingest —
      // no upscaling, no black borders, no pillar-box). Ingest is now
      // uniformly 854x480 across every channel, so this concat re-encode
      // is effectively 1:1 with the source segments. Same 700k target
      // → ~5 MB/min output regardless of duration.
      //
      // Serialised by buildLocks + capped by dlAcquire semaphore so
      // this can't dogpile with 24/7 recording ffmpegs.
      await dlAcquire();
      try {
        await runFf([
          '-hide_banner', '-loglevel', 'error', '-y',
          '-err_detect', 'ignore_err',
          // +genpts+igndts were overriding the concat demuxer's native
          // cross-file timestamp continuity and injecting PTS resets at
          // every boundary — the mp4 muxer then wrote an index that
          // media players treat as damaged. Removed 2026-10-11 after a
          // user reported "download first click 500, second click
          // succeeds but file won't play in media player".
          '-fflags', '+discardcorrupt',
          '-f', 'concat', '-safe', '0', '-i', listPath,
          '-vf', 'scale=854:480:flags=lanczos',
          '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
          '-profile:v', 'main', '-pix_fmt', 'yuv420p',
          '-threads', '2',
          '-b:v', '700k', '-maxrate', '1000k', '-bufsize', '2000k',
          '-fps_mode', 'cfr', '-r', '25',
          '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '48000',
          '-movflags', '+faststart',
          outPath,
        ]);
      } finally {
        dlRelease();
      }
      // Belt-and-braces validation. The old size>1024 check let a
      // corrupt mp4 (writeable but with a broken moov atom) through
      // the cache — that was the "second click downloads but won't
      // play" symptom. ffmpeg -v error -f null - exits non-zero on
      // files that can't be opened, which is the exact check a media
      // player would run. ffprobe would be cleaner but isn't shipped
      // on the CMC Windows ffmpeg build.
      if (!existsSync(outPath) || statSync(outPath).size < 1024) {
        throw new Error('ffmpeg produced empty output');
      }
      const checkOk = await new Promise<boolean>((resolve) => {
        const probe = spawn('ffmpeg', [
          '-v', 'error', '-i', outPath, '-c', 'copy',
          '-t', '0.1', '-f', 'null', '-',
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        probe.on('exit', (code) => resolve(code === 0));
        probe.on('error', () => resolve(false));
      });
      if (!checkOk) {
        throw new Error('ffmpeg output is not playable (bad mp4 header or codec)');
      }
      return outPath;
    })().catch((err) => {
      // Wipe partial file so the NEXT click retries from scratch
      // instead of the existsSync check up top returning a stale broken cache.
      try { if (existsSync(outPath)) unlinkSync(outPath); } catch { /* */ }
      throw err;
    }).finally(() => setTimeout(() => buildLocks.delete(key), 1000));

    buildLocks.set(key, p);
    return p;
  }

  /**
   * HLS playlist for a recording session. Each 60-s MP4 segment shows
   * up as one HLS entry pointing at /segment-ts/:id which remuxes it
   * to MPEG-TS on demand (and caches). hls.js sees a normal VOD
   * playlist — first byte arrives in ~200 ms, seek jumps directly to
   * the target segment, no whole-file wait ever again.
   */
  app.get('/session.m3u8', async (req, reply) => {
    const q = (req.query as { channelId?: string; from?: string; to?: string }) ?? {};
    if (!q.channelId || !q.from || !q.to) return reply.badRequest('channelId, from, to required');
    const from = new Date(q.from);
    const to   = new Date(q.to);

    const segments = await app.prisma.recordingSegment.findMany({
      where: {
        channelId: q.channelId,
        startedAt: { gte: new Date(from.getTime() - 5 * 60 * 1000), lte: to },
      },
      orderBy: { startedAt: 'asc' },
    });
    const covering = segments.filter((s) => {
      const end = new Date(s.startedAt.getTime() + s.durationMs);
      return end > from && s.startedAt < to;
    });
    if (covering.length === 0) return reply.notFound('no segments cover this range');

    // Filter out zero-length / stub / half-written files up front — the
    // ffmpeg segment split would 500 with 'Invalid data found' otherwise
    // and hls.js has no clean way to recover mid-playlist. Cheap ffprobe
    // check filters the recorder's crash-truncated MP4s.
    const playable: typeof covering = [];
    for (const s of covering) {
      if (!existsSync(s.path)) continue;
      if (statSync(s.path).size < 4096) continue;
      if (!(await isPlayable(s.path))) continue;
      // Skip only truly-corrupt tail flushes (< 3 s). Original guard
      // was 20 s and dropped legit short recordings — BOL News writes
      // ~7 s segments per minute and every clip in that window came
      // back "no playable segments in range" (2026-09-07). Real
      // crash-tail flushes are the sub-second/single-digit ones with
      // multi-minute mvhd nonsense; healthy short recordings (source
      // hiccup, segment early-close, transcode restart) probe fine
      // and slice fine. isPlayable + the slicer's EMPTY_TS fallback
      // catch anything sub-3 s that sneaks through anyway.
      if (s.durationMs < 3000) continue;
      // Session HLS depends on ACCURATE durationMs — hls.js interpolates
      // fragment PDT from declared EXTINFs, so a stale value makes
      // sub-segment slots 404 and drifts the client's wall-time reading
      // (reported 2026-09-04 on 92-news). We re-estimate from mtime -
      // startedAt on any row that still carries the pre-fix defaults
      // (hardcoded 60 000 or the earlier probe run that returned bogus
      // 250 000+ ms values from fMP4 empty_moov).
      //
      // 2026-09-07: also re-estimate anything < 55 000 that references a
      // file bigger than ~4 MB. Windows' NTFS updates mtime lazily while
      // ffmpeg is still writing, so the ingest scan (which runs every
      // few seconds and only skips files whose mtime is < 2 s old) can
      // read a mid-write file, compute mtime - startedAt = ~7 s, insert
      // a 7-s row, then write the .recorded marker. When ffmpeg
      // eventually closes the file 60 s later, the DB row never gets
      // updated — every clip that intersects that hour returned <1/8 of
      // the real content. Fresh recompute here reads the NOW-final mtime
      // and heals the row for the future.
      const suspiciouslyShort = s.durationMs < 55000
        && existsSync(s.path)
        && statSync(s.path).size > 4_000_000;
      if (s.durationMs === 60000 || s.durationMs > 120000 || suspiciouslyShort) {
        const measured = estimateSegmentDurationMs(s.path, s.startedAt.getTime());
        if (measured && Math.abs(measured - s.durationMs) > 300) {
          try {
            await app.prisma.recordingSegment.update({ where: { id: s.id }, data: { durationMs: measured } });
            s.durationMs = measured;
          } catch { /* concurrent writer beat us; leave */ }
        }
      }
      playable.push(s);
    }
    if (playable.length === 0) return reply.notFound('no playable segments in range');

    // Dedup HEAVILY overlapping segments (>= 5 s). The recording
    // supervisor sometimes has two ffmpegs running in parallel for the
    // same channel (spawn respawns while the previous is still
    // writing), so two consecutive .mp4 files can cover the same
    // wall-clock window with a 20-40 s overlap. Playing both shows
    // the same content twice and — because the two files' PDT anchors
    // point at different offsets within the same wall time — hls.js's
    // per-fragment PDT reports the wrong wall time for a given player
    // position, so mark-in/out send server timestamps that map to a
    // different physical file than what the operator saw.
    //
    // The 5-second threshold matters: sequential 60-s segments from a
    // single ffmpeg naturally overlap by 1-2 s (ffmpeg's -segment_time
    // splits at the nearest keyframe, so real segment boundaries are
    // ±1 s jitter). Treating that jitter as "overlap" and dropping
    // alternates leaves the session with only every-other 60-s chunk,
    // and the player shows ~half the real content — reported for
    // Dunya News 2026-09-08 where a 6-min real recording played back
    // as 3:47 (also 92/GNN/Neo/SUNO/Aik).
    const deduped: typeof playable = [];
    for (const s of playable) {
      const prev = deduped[deduped.length - 1];
      if (prev) {
        const prevEnd = prev.startedAt.getTime() + prev.durationMs;
        const overlapMs = prevEnd - s.startedAt.getTime();
        if (overlapMs >= 5000) continue;   // real duplicate — skip
      }
      deduped.push(s);
    }
    // Rebind: everything downstream uses `playable`, so alias it back.
    playable.length = 0;
    playable.push(...deduped);

    // Each 60-s recorded MP4 is exposed as ~10 sub-segments of ~6 s
    // (SUB_DURATION). Playlist lists every sub-segment across the
    // session, so hls.js loads ONLY the sub-segment(s) around the
    // current playhead — jumping to minute 47 of a 5-hour session
    // downloads ~6 s / ~1.5 MB of TS, not the full 60 s / 15 MB
    // containing segment. Combined with hls.js maxBufferLength=12 s
    // on the client, we hold two chunks ahead + one back, no more,
    // regardless of session length.
    const SUB_DURATION = 6;
    const lines: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${SUB_DURATION + 1}`,
      '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];
    // Anchor the timeline to the actual first playable segment's wall
    // clock. Without this, the client had to derive absolute timestamps
    // from a `sessionStart` URL param that could differ from the true
    // first-segment start by up to a segment length (the m3u8 query
    // widens the window ~5 min back to catch straddling segments), so
    // mark-in/out coordinates were offset by ~30-60 s and exported
    // clips came from a different point than the operator marked
    // (reported for ptv-world 2026-08-25). With PDT emitted, hls.js
    // exposes `hls.playingDate` = wall-clock time of the current
    // frame, so the client can send true UTC timestamps instead of
    // `sessionStart + relativeSeconds` math.
    const firstPlayableStart = playable[0]!.startedAt;
    // Kept for the first segment; per-boundary PDT below re-anchors
    // every discontinuity so drift can't accumulate across many
    // segments (reported for HUM News 2026-08-25 — long sessions
    // drifted clip marks by tens of seconds because hls.js was
    // extrapolating from a single PDT + EXTINFs that don't exactly
    // sum to actual segment durations).
    lines.push(`#EXT-X-PROGRAM-DATE-TIME:${firstPlayableStart.toISOString()}`);
    // For each segment we need the ACTUAL slice count that ffmpeg's
    // segment muxer produced (or will produce). Estimating with
    // ceil(dur/6) is wrong when the tail is short — ffmpeg emits N
    // slices where N = number of keyframes at 6 s boundaries, which
    // for a 60 s file with 1 s GOP can be 9, 10, or 11 depending on
    // alignment. Using an inflated estimate causes 404s at playback
    // (which stalls hls.js).
    //
    // Strategy: (a) if we already split this segment, read the actual
    // count from disk; (b) otherwise use a SAFE UNDERSTATE
    // (floor(dur/6) - 1, clamped to ≥1). We'd rather cut ~6 s off the
    // trailing edge of a segment than have hls.js hit a 404. The next
    // segment starts right after via #EXT-X-DISCONTINUITY anyway.
    for (let i = 0; i < playable.length; i++) {
      const s = playable[i];
      if (i > 0) {
        lines.push('#EXT-X-DISCONTINUITY');
        // Re-anchor timeline at every discontinuity so hls.js's
        // `programDateTime` for the current fragment is always the
        // TRUE wall-clock start of that segment (from the DB row),
        // not "first PDT + sum-of-declared-EXTINFs" which drifts
        // whenever declared durations don't match ffmpeg's actual
        // slice durations.
        lines.push(`#EXT-X-PROGRAM-DATE-TIME:${s.startedAt.toISOString()}`);
      }
      // CLAMP declared duration to actual wall-clock room before the
      // next segment (or before the `to` query bound for the last
      // segment). Prevents the "player says 4:02 but recording is
      // 2:06" bug where a stale/inflated durationMs (rollover files,
      // bad probe of mid-write MP4, 24h span accidentally recorded)
      // makes hls.js compute a timeline longer than the real content
      // — the operator then marks past the end and the clip window
      // maps to nothing on disk (2026-09-15 PTV News 25-s clip came
      // back as 261 B). Real content in the .ts slices doesn't change;
      // we only trim what the manifest tells the player.
      let effectiveDurMs = s.durationMs;
      const nextStartMs = i + 1 < playable.length
        ? playable[i + 1]!.startedAt.getTime()
        : to.getTime();
      const roomMs = nextStartMs - s.startedAt.getTime();
      if (roomMs > 0 && effectiveDurMs > roomMs) effectiveDurMs = roomMs;
      const durS = effectiveDurMs / 1000;
      const dir = join(HLS_CACHE, s.id);
      let nSub: number;
      if (existsSync(join(dir, '.ready'))) {
        // Count actual .ts files produced by ffmpeg.
        try {
          nSub = readdirSync(dir).filter((f: string) => f.endsWith('.ts')).length;
        } catch {
          nSub = Math.max(1, Math.floor(durS / SUB_DURATION));
        }
      } else {
        nSub = Math.max(1, Math.floor(durS / SUB_DURATION));
      }
      for (let k = 0; k < nSub; k++) {
        const remaining = durS - k * SUB_DURATION;
        const thisDur = Math.min(SUB_DURATION, Math.max(1, remaining));
        lines.push(`#EXTINF:${thisDur.toFixed(3)},`);
        lines.push(`/api/recordings/segment-hls/${s.id}/${k}.ts`);
      }
    }
    lines.push('#EXT-X-ENDLIST');

    // Pre-warm sub-segment #0 of the first playable segment. First
    // slice extraction shells out to ffmpeg segment-muxer which also
    // writes ALL the other slices of that 60-s file at once — so a
    // single pre-warm covers the whole first minute of playback with
    // ~200 ms of server work. Fire-and-forget.
    if (playable.length > 0) {
      segmentToHlsSlices({ id: playable[0]!.id, path: playable[0]!.path, durationMs: playable[0]!.durationMs }).catch(() => {});
    }

    reply
      .header('Content-Type', 'application/vnd.apple.mpegurl')
      .header('Cache-Control', 'no-cache');
    return lines.join('\n');
  });

  /**
   * MP4 → 6-second MPEG-TS slices via ffmpeg's segment muxer. Splits
   * ALL slices of the 60-s file in a single ffmpeg invocation
   * (~200 ms on the R740xd) — cheaper than firing ffmpeg 10 times.
   * Result cached in /tmp/demp-hls/<segId>/{0,1,2,...}.ts.
   */
  const HLS_CACHE = join(tmpdir(), 'demp-hls');
  mkdirSync(HLS_CACHE, { recursive: true });
  const hlsLocks = new Map<string, Promise<void>>();

  async function segmentToHlsSlices(seg: { id: string; path: string; durationMs?: number }): Promise<void> {
    mkdirSync(HLS_CACHE, { recursive: true });
    const outDir = join(HLS_CACHE, seg.id);
    const readyMarker = join(outDir, '.ready');
    if (existsSync(readyMarker)) return;
    if (hlsLocks.has(seg.id)) return hlsLocks.get(seg.id)!;

    // Cap the slicer at the segment's known real duration. Without this
    // the recording ffmpeg's fragmented-mp4 headers (empty_moov +
    // fake-timescale mvhd, e.g. 4:14 for a 1.66-s file) cause the
    // re-encode pass to pad frames out to the bogus header duration and
    // spit out dozens of phantom slices of black. Reported 2026-09-04
    // on hum-news — cache dir grew to 22 slices for a 1.66-s segment
    // and the playlist referenced all of them, wrecking wall-time
    // alignment and blowing up as bufferAppendError when hls.js hit a
    // slice with no matching PDT context.
    const capSec = seg.durationMs && seg.durationMs > 500 && seg.durationMs < 900_000
      ? (seg.durationMs / 1000).toFixed(3)
      : null;

    const p = (async () => {
      mkdirSync(outDir, { recursive: true });
      await new Promise<void>((resolve, reject) => {
        // Was -c copy + h264_mp4toannexb. Broke on transcoded segments
        // (fMP4 with empty_moov) — SPS/PPS were missing from later
        // slices → hls.js bufferAppendError → black screen.
        //
        // Now re-encode. Ultrafast 640x360 on a 6-s clip is ~150 ms of
        // CPU, one-shot per segment, cached afterwards. Every slice
        // gets clean SPS/PPS + a keyframe at position 0, so hls.js
        // handles them uniformly regardless of source (transcoded
        // fMP4 or -c copy source-quality mp4). AAC 64k audio matches
        // what the download endpoint uses.
        const ffArgs: string[] = [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-err_detect', 'ignore_err',
          '-fflags', '+genpts+discardcorrupt',
          '-i', seg.path,
        ];
        if (capSec) { ffArgs.push('-t', capSec); }
        const ff = spawn('ffmpeg', [
          ...ffArgs,
          // fps=25 coerces high-framerate sources to a browser-safe rate.
          // Al Jazeera Arabic ships 1080p @ 50 fps with mp3 audio; hls.js
          // throws fragParsingError after ~2 s of black on the resulting
          // MPEG-TS. Forcing constant 25 fps at the filter stage produces
          // slices every browser handles uniformly regardless of source
          // frame rate (25 / 25.4 / 30 / 50).
          '-vf', 'scale=854:480:flags=lanczos,fps=25',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-profile:v', 'main', '-pix_fmt', 'yuv420p',
          '-g', '48', '-force_key_frames', 'expr:gte(t,n_forced*2)',
          '-b:v', '500k', '-maxrate', '700k', '-bufsize', '1400k',
          '-c:a', 'aac', '-b:a', '64k', '-ac', '2', '-ar', '48000',
          '-f', 'segment',
          '-segment_time', '6',
          '-segment_format', 'mpegts',
          // reset_timestamps=1 was the CAUSE of the 5.9s-then-loading
          // stall reported 2026-08-21 (network tab showed all .ts
          // slices served from disk cache, size=0B, 2-10ms — proving
          // fetches were instant; the stall was on the CLIENT side).
          // Under reset_timestamps=1 each slice restarted PTS at 0,
          // and MSE (Media Source Extensions inside hls.js) requires
          // MONOTONIC PTS across appended fragments. Slice 1's first
          // frame at PTS 0 was less than slice 0's last frame at ~6s
          // → MSE stalled waiting for "future" data → visible pause
          // at every 6-s slice boundary. Removed. Continuous PTS
          // across slices in the same 60-s segment; the
          // #EXT-X-DISCONTINUITY between segments still resets on
          // the 60-s boundary as intended.
          '-avoid_negative_ts', 'make_zero',
          '-muxdelay', '0', '-muxpreload', '0',
          join(outDir, '%d.ts'),
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        ff.stderr.on('data', (b) => { tail += b.toString(); });
        ff.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${tail.slice(-200)}`)));
        ff.on('error', reject);
      });
      // Drop any 0-byte .ts files. ffmpeg's `-f segment` splitter can
      // produce an empty trailing slice when the source duration isn't
      // a clean multiple of segment_time (58-s Al Jazeera clips left a
      // 0-byte 7.ts alongside valid 0.ts–6.ts). Serving that 0-byte
      // file to hls.js triggers `fragParsingError` and blanks the
      // player. Delete the empties so the segment-hls handler's
      // missing-slice fallback serves the previous good one instead.
      try {
        for (const f of readdirSync(outDir)) {
          if (!f.endsWith('.ts')) continue;
          const p = join(outDir, f);
          if (statSync(p).size === 0) unlinkSync(p);
        }
      } catch { /* best-effort cleanup */ }
      // Sentinel file signals "all slices done writing".
      writeFileSync(readyMarker, '');
    })().finally(() => setTimeout(() => hlsLocks.delete(seg.id), 500));

    hlsLocks.set(seg.id, p);
    return p;
  }

  app.get('/segment-hls/:id/:slice.ts', async (req, reply) => {
    const { id, slice } = req.params as { id: string; slice: string };
    const sliceIdx = Number.parseInt(slice, 10);
    if (!Number.isFinite(sliceIdx) || sliceIdx < 0) return reply.badRequest('bad slice index');

    const seg = await app.prisma.recordingSegment.findUnique({ where: { id } });
    if (!seg) return reply.notFound();
    if (!existsSync(seg.path)) return reply.notFound('source missing');

    try {
      await segmentToHlsSlices({ id: seg.id, path: seg.path, durationMs: seg.durationMs });
    } catch (e) {
      // Broken source MP4 (recorder killed mid-write, 'Invalid data
      // found on input') — don't 500 in a loop. Return an empty valid
      // MPEG-TS packet so hls.js just treats this slice as a gap and
      // moves on to the next segment via the playlist's DISCONTINUITY.
      app.log.warn({ segId: seg.id, err: e instanceof Error ? e.message : String(e) }, 'slice extract failed — sending empty TS');
      const EMPTY_TS = Buffer.alloc(188, 0xff); EMPTY_TS[0] = 0x47; EMPTY_TS[1] = 0x1f; EMPTY_TS[2] = 0xff; EMPTY_TS[3] = 0x10;
      reply.header('Content-Type', 'video/mp2t').header('Content-Length', 188);
      return reply.send(EMPTY_TS);
    }
    let filePath = join(HLS_CACHE, seg.id, `${sliceIdx}.ts`);
    // Treat 0-byte slice as missing. `-f segment` occasionally leaves
    // an empty trailing .ts when the source duration isn't a clean
    // multiple of segment_time. The post-generation cleanup deletes
    // those but old cache dirs may still contain them; either way,
    // serving a 0-byte file triggers hls.js `fragParsingError`.
    const slicePresent = existsSync(filePath) && statSync(filePath).size > 0;
    if (!slicePresent) {
      // Off-by-one at the tail of a segment — ffmpeg produced fewer
      // slices than the playlist advertised. Serve the last existing
      // slice so hls.js doesn't stall. (Playlist generator now
      // understates rather than overstates, so this path should be
      // rare, but keep the safety net.)
      try {
        const slices = readdirSync(join(HLS_CACHE, seg.id))
          .filter((f: string) => f.endsWith('.ts'))
          .map((f: string) => Number.parseInt(f, 10))
          .filter((n: number) => Number.isFinite(n))
          .sort((a: number, b: number) => a - b);
        if (slices.length === 0) return reply.notFound('slice out of range');
        const last = slices[slices.length - 1];
        filePath = join(HLS_CACHE, seg.id, `${last}.ts`);
      } catch {
        return reply.notFound('slice out of range');
      }
    }

    // Pre-warm the NEXT segment's slices while the client is still
    // decoding this one — keeps the pipeline hot across the boundary.
    if (sliceIdx === 0) {
      const nextSeg = await app.prisma.recordingSegment.findFirst({
        where: { channelId: seg.channelId, startedAt: { gt: seg.startedAt } },
        orderBy: { startedAt: 'asc' },
      });
      if (nextSeg && existsSync(nextSeg.path)) {
        segmentToHlsSlices({ id: nextSeg.id, path: nextSeg.path, durationMs: nextSeg.durationMs }).catch(() => {});
      }
    }

    const st = statSync(filePath);
    reply
      .header('Content-Type', 'video/mp2t')
      .header('Content-Length', st.size)
      .header('Cache-Control', 'public, max-age=3600');
    return reply.send(createReadStream(filePath));
  });

  /**
   * MP4 → MPEG-TS remux for a single segment. Stream-copy + Annex-B
   * bitstream filter (~100 ms per 60 s segment on the R740xd). Result
   * is cached on disk keyed by segment id.
   */
  const TS_CACHE = join(tmpdir(), 'demp-ts');
  mkdirSync(TS_CACHE, { recursive: true });
  const tsLocks = new Map<string, Promise<string | null>>();

  async function segmentToTs(seg: { id: string; path: string }): Promise<string | null> {
    mkdirSync(TS_CACHE, { recursive: true });
    const outPath = join(TS_CACHE, `${seg.id}.ts`);
    if (existsSync(outPath) && statSync(outPath).size > 0) return outPath;
    if (tsLocks.has(seg.id)) return tsLocks.get(seg.id)!;

    const p = (async () => {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', seg.path,
          '-c', 'copy',
          '-bsf:v', 'h264_mp4toannexb',
          '-f', 'mpegts',
          outPath,
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        let tail = '';
        ff.stderr.on('data', (b) => { tail += b.toString(); });
        ff.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${tail.slice(-200)}`)));
        ff.on('error', reject);
      });
      return outPath;
    })().finally(() => setTimeout(() => tsLocks.delete(seg.id), 500));

    tsLocks.set(seg.id, p);
    return p;
  }

  app.get('/segment-ts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const seg = await app.prisma.recordingSegment.findUnique({ where: { id } });
    if (!seg) return reply.notFound();
    if (!existsSync(seg.path)) return reply.notFound('source missing');

    let tsPath: string | null;
    try {
      tsPath = await segmentToTs({ id: seg.id, path: seg.path });
    } catch (e) {
      return reply.code(500).send({ error: 'remux failed', detail: e instanceof Error ? e.message : String(e) });
    }
    if (!tsPath) return reply.notFound('remux produced nothing');

    const st = statSync(tsPath);
    reply
      .header('Content-Type', 'video/mp2t')
      .header('Content-Length', st.size)
      .header('Cache-Control', 'public, max-age=3600');
    return reply.send(createReadStream(tsPath));
  });

  /**
   * Audio-waveform peaks for a session — WaveSurfer.js consumes the
   * `peaks` array directly. We ffprobe each segment to raw s16le mono
   * at 4 kHz (~8 KB per 60-s segment), stitch, then bucket into N
   * max-absolute peaks. The whole result is small enough (~40 KB for
   * a 1-hour session at buckets=2000) to send inline and cache.
   */
  const PEAKS_CACHE = join(tmpdir(), 'demp-peaks');
  mkdirSync(PEAKS_CACHE, { recursive: true });

  app.get('/session-peaks.json', async (req, reply) => {
    const q = (req.query as { channelId?: string; from?: string; to?: string; buckets?: string }) ?? {};
    if (!q.channelId || !q.from || !q.to) return reply.badRequest('channelId, from, to required');
    const from = new Date(q.from);
    const to   = new Date(q.to);
    const buckets = Math.min(4000, Math.max(200, Number(q.buckets) || 1500));

    const key = createHash('sha1').update(`${q.channelId}:${from.getTime()}:${to.getTime()}:${buckets}`).digest('hex').slice(0, 20);
    const cachePath = join(PEAKS_CACHE, `${key}.json`);
    if (existsSync(cachePath) && statSync(cachePath).size > 0) {
      reply.header('Content-Type', 'application/json').header('Cache-Control', 'public, max-age=3600');
      return reply.send(createReadStream(cachePath));
    }

    const segments = await app.prisma.recordingSegment.findMany({
      where: {
        channelId: q.channelId,
        startedAt: { gte: new Date(from.getTime() - 5 * 60 * 1000), lte: to },
      },
      orderBy: { startedAt: 'asc' },
    });
    const covering = segments.filter((s) => {
      const end = new Date(s.startedAt.getTime() + s.durationMs);
      return end > from && s.startedAt < to;
    });
    if (covering.length === 0) return reply.notFound();

    // Drop segments whose on-disk size is clearly short of a 60-s
    // fMP4 (ingest ffmpeg crashed/respawned mid-write — the file
    // header is truncated and the mp4 demuxer aborts on it, which
    // then cascades through the concat demuxer and kills the whole
    // decode. ABB TAKK on 2026-10-07 had ~12 of 52 segments in a
    // 32-min window land under 6 MB because the ingest kept hitting
    // non-monotonic DTS and respawning). We'd rather drop a few
    // seconds of silence from the waveform than lose the whole thing.
    // 6 MB ≈ 20 s at the normal ingest bitrate — anything shorter
    // was almost certainly a crash-stub.
    const PARTIAL_BYTES = 6_000_000;
    const playable = covering.filter((s) => {
      try {
        const sz = statSync(s.path).size;
        return sz >= PARTIAL_BYTES;
      } catch { return false; }
    });
    const skipped = covering.length - playable.length;
    if (skipped > 0) {
      app.log.warn({ channelId: q.channelId, from: q.from, to: q.to, covering: covering.length, playable: playable.length, skipped }, 'waveform: skipped partial segments');
    }
    if (playable.length === 0) return reply.notFound();

    // Decode ALL segments in ONE ffmpeg concat call, not N sequential
    // spawns. A 60-min session (60 segments) went from 60 × ~1 s spawns
    // (~1 min wall-clock — client timeout → "Waveform unavailable")
    // to a single stream that finishes in ~5-10 s. Concat + `-c copy`
    // audio-only isn't safe if per-segment codecs vary, so we decode
    // to raw s16le mono @ 4 kHz which normalises everything.
    const totalDurMs = playable.reduce((n, s) => n + s.durationMs, 0);
    const sr = 4000;
    const expectedSamples = Math.floor((totalDurMs / 1000) * sr);
    const buf = new Int16Array(expectedSamples);
    let offset = 0;
    const listPath = join(PEAKS_CACHE, `list-${key}.txt`);
    const listBody = playable
      .map((s) => `file '${s.path.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
      .join('\n');
    writeFileSync(listPath, listBody);
    let ffExitCode: number | null = null;
    let ffStderr = '';
    try {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve) => {
        const ff = spawn('ffmpeg', [
          '-hide_banner', '-loglevel', 'error', '-nostdin',
          // Trust concat demuxer's native cross-file timestamp
          // continuity (dropped +genpts and +igndts because they
          // override it and cause decoder resets at boundaries).
          '-fflags', '+discardcorrupt',
          '-err_detect', 'ignore_err',
          '-f', 'concat', '-safe', '0', '-i', listPath,
          '-vn', '-ac', '1', '-ar', String(sr),
          '-f', 's16le', '-',
        ], { stdio: ['ignore', 'pipe', 'pipe'] });
        // 5-minute hard cap. A 6-hour session (360 segments) takes
        // 60-120 s wall to decode through one concat call at 4 kHz mono
        // s16le. Old 90 s cap was killing 6-hour+ requests mid-decode
        // and returning HTTP 500 to the operator.
        const kill = setTimeout(() => { try { ff.kill('SIGKILL'); } catch {} }, 300_000);
        ff.stdout.on('data', (b) => chunks.push(b));
        ff.stderr?.on('data', (b: Buffer) => { if (ffStderr.length < 8192) ffStderr += b.toString('utf8'); });
        ff.on('exit', (code) => { ffExitCode = code; clearTimeout(kill); resolve(); });
        ff.on('error', (err) => { ffStderr += `\nspawn error: ${err.message}`; clearTimeout(kill); resolve(); });
      });
      const wav = Buffer.concat(chunks);
      // Guard against odd-byte stdout (ffmpeg killed mid-sample).
      // Int16Array constructor requires a byteLength aligned to 2.
      const alignedBytes = wav.byteLength - (wav.byteLength % 2);
      const samples = new Int16Array(wav.buffer, wav.byteOffset, alignedBytes / 2);
      const room = Math.min(samples.length, buf.length);
      buf.set(samples.subarray(0, room));
      offset = room;
      // Explicit log of what the decode actually produced so we can
      // tell "no samples at all" (hard failure) from "a few samples"
      // (partial success → flat-ish waveform) from the API log.
      app.log.info({
        channelId: q.channelId,
        from: q.from,
        to: q.to,
        playableSegments: playable.length,
        skippedPartialSegments: skipped,
        ffExitCode,
        bytesDecoded: wav.byteLength,
        samplesStored: offset,
        expectedSamples,
        ffStderrHead: ffStderr.slice(0, 400),
      }, 'waveform: decode complete');
      // If ffmpeg produced effectively nothing and exited non-zero,
      // return a clear 500 instead of a flatline waveform that the
      // operator reads as "unavailable" with no explanation.
      if (offset === 0 && ffExitCode !== 0) {
        return reply.code(500).send({
          error: 'waveform decode produced no samples',
          ffExitCode,
          skippedPartialSegments: skipped,
          ffStderrHead: ffStderr.slice(0, 400),
        });
      }
    } finally {
      try { unlinkSync(listPath); } catch {}
    }

    // Downsample to `buckets` peaks (max abs value per bucket → normalised 0-1).
    const bucketSize = Math.max(1, Math.floor(offset / buckets));
    const peaks: number[] = new Array(buckets);
    for (let b = 0; b < buckets; b++) {
      let peak = 0;
      const start = b * bucketSize;
      const end = Math.min(offset, start + bucketSize);
      for (let i = start; i < end; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
      }
      peaks[b] = Number((peak / 32768).toFixed(3));
    }

    const body = JSON.stringify({ sampleRate: sr, buckets, duration: totalDurMs / 1000, peaks });
    // Best-effort write, ignore ENOENT if tmp was cleaned mid-request.
    try { writeFileSync(cachePath, body); } catch {}
    reply.header('Content-Type', 'application/json').header('Cache-Control', 'public, max-age=3600');
    return reply.send(body);
  });

  app.get('/session-media', async (req, reply) => {
    const q = (req.query as { channelId?: string; from?: string; to?: string }) ?? {};
    if (!q.channelId || !q.from || !q.to) return reply.badRequest('channelId, from, to required');
    const from = new Date(q.from);
    const to   = new Date(q.to);
    let outPath: string | null;
    try {
      outPath = await buildSessionMp4(q.channelId, from, to);
    } catch (e) {
      return reply.code(500).send({ error: 'render failed', detail: e instanceof Error ? e.message : String(e) });
    }
    if (!outPath) return reply.notFound('no segments cover this range');

    const stat = statSync(outPath);
    // Filename: <slug>_<startISO>.mp4 — nice for the operator to search
    // downloaded files later. slug comes from a lookup because we only
    // have channelId in the query.
    let filename = `recording-${q.from}.mp4`;
    try {
      const ch = await app.prisma.channel.findUnique({ where: { id: q.channelId }, select: { slug: true } });
      if (ch) {
        const stamp = q.from.replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
        filename = `${ch.slug}_${stamp}.mp4`;
      }
    } catch { /* fall back to default filename */ }

    const range = (req.headers.range as string | undefined) ?? '';
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = Number(startStr);
      const end = endStr ? Number(endStr) : stat.size - 1;
      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${stat.size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', end - start + 1)
        .header('Content-Type', 'video/mp4')
        .header('Content-Disposition', `attachment; filename="${filename}"`);
      return reply.send(createReadStream(outPath, { start, end }));
    }
    reply
      .header('Content-Length', stat.size)
      .header('Content-Type', 'video/mp4')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(createReadStream(outPath));
  });

  // Stream the media file itself. Range-request friendly.
  app.get('/:id/stream', async (req, reply) => {
    const { id } = req.params as { id: string };
    const seg = await app.prisma.recordingSegment.findUnique({ where: { id } });
    if (!seg) return reply.notFound();
    if (!existsSync(seg.path)) return reply.notFound('file missing');

    const stat = statSync(seg.path);
    const range = (req.headers.range as string | undefined) ?? '';
    if (range) {
      const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
      const start = Number(startStr);
      const end = endStr ? Number(endStr) : stat.size - 1;
      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${stat.size}`)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', end - start + 1)
        .header('Content-Type', 'video/mp4');
      return reply.send(createReadStream(seg.path, { start, end }));
    }
    reply.header('Content-Length', stat.size).header('Content-Type', 'video/mp4');
    return reply.send(createReadStream(seg.path));
  });
};

export default routes;
