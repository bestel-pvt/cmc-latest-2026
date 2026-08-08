/**
 * Frames — operator-triggered still captures of a live channel.
 *
 * Storage is filesystem-only (no Prisma model): each frame is a PNG
 * under `<DATA_DIR>/frames/<yyyy-mm-dd>/<channelId>_<isoUtc>.png`. The
 * filename is the frame's ID, so listing = a directory scan and
 * delete = an fs.unlink. Zero DB pressure.
 *
 * Capture path: read the last segment of live-hls's on-disk playlist
 * with `ffmpeg -frames:v 1 -q:v 2` — ~500 ms per shot, no UDP hop, no
 * decoder warmup. The POST /channels/:id/snapshot handler lives in
 * routes/channels.ts and reuses grabFrame + FRAMES_DIR from here.
 *
 * Mounted at `/api/frames` in server.ts.
 */

import type { FastifyPluginAsync } from 'fastify';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync, statSync, unlinkSync, createReadStream } from 'node:fs';
import path from 'node:path';

const FFMPEG   = process.env.FFMPEG_PATH ?? 'ffmpeg';
const HLS_DIR  = path.resolve(process.env.HLS_DIR ?? './data/hls');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
// Frames live on the big storage volume next to recordings + clips.
// If FRAMES_DIR is set in .env (e.g. D:\cmc\frames) use it verbatim;
// otherwise fall back to <DATA_DIR>/frames for local dev.
export const FRAMES_DIR = process.env.FRAMES_DIR
  ? path.resolve(process.env.FRAMES_DIR)
  : path.join(DATA_DIR, 'frames');

/** `<channelId>_<isoUtc>.png` — filename encodes everything the UI needs. */
export function frameFilename(channelId: string, capturedAt: Date): string {
  return `${channelId}_${capturedAt.toISOString().replace(/[:.]/g, '-')}.png`;
}

/** Grab a single PNG from a local HLS playlist. Returns true on success. */
export async function grabFrameFromHls(playlistPath: string, outPath: string, timeoutMs = 8000): Promise<boolean> {
  if (!existsSync(playlistPath)) return false;
  return await new Promise((resolve) => {
    const args = [
      '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-f', 'hls',
      '-i', playlistPath,
      '-frames:v', '1', '-q:v', '2', '-f', 'image2',
      outPath,
    ];
    const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let killed = false;
    const to = setTimeout(() => { killed = true; try { ff.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    ff.on('exit', (code) => {
      clearTimeout(to);
      if (killed || code !== 0 || !existsSync(outPath) || statSync(outPath).size === 0) {
        try { unlinkSync(outPath); } catch { /* */ }
        return resolve(false);
      }
      resolve(true);
    });
    ff.on('error', () => { clearTimeout(to); resolve(false); });
  });
}

/** Directory scan → flat frame list, newest first. */
export function listAllFrames(): Array<{
  id: string; channelId: string; capturedAt: string; sizeBytes: number; imageUrl: string;
}> {
  if (!existsSync(FRAMES_DIR)) return [];
  const out: Array<{ id: string; channelId: string; capturedAt: string; sizeBytes: number; imageUrl: string; mtimeMs: number }> = [];
  for (const day of readdirSync(FRAMES_DIR)) {
    const dayDir = path.join(FRAMES_DIR, day);
    if (!statSync(dayDir).isDirectory()) continue;
    for (const f of readdirSync(dayDir)) {
      if (!f.endsWith('.png')) continue;
      const full = path.join(dayDir, f);
      const st = statSync(full);
      const m = f.match(/^([^_]+)_(.+)\.png$/);
      if (!m) continue;
      // reverse of frameFilename: "2026-08-08T14-15-30-123Z" → ISO
      const rawStamp = m[2]!;
      const isoStamp = rawStamp
        .replace(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/, '$1-$2-$3T$4:$5:$6.$7Z');
      out.push({
        id: `${day}/${f}`,
        channelId: m[1]!,
        capturedAt: isoStamp,
        sizeBytes: st.size,
        imageUrl: `/api/frames/${encodeURIComponent(`${day}/${f}`)}/image`,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.map(({ mtimeMs: _m, ...rest }) => rest);
}

const routes: FastifyPluginAsync = async (app) => {
  // Image GET is public so <img src=...> works without a bearer header.
  app.addHook('preHandler', async (req, reply) => {
    if (req.method === 'GET' && /^\/api\/frames\/[^/]+\/image$/.test(req.raw.url ?? '')) return;
    return app.authenticate(req, reply);
  });

  /** GET /api/frames — list all frames (optionally filter by channel/date/query). */
  app.get('/', async (req) => {
    const q = (req.query as { channelId?: string; from?: string; to?: string; q?: string }) ?? {};
    let frames = listAllFrames();
    if (q.channelId) frames = frames.filter((f) => f.channelId === q.channelId);
    if (q.from)      frames = frames.filter((f) => f.capturedAt >= q.from!);
    if (q.to)        frames = frames.filter((f) => f.capturedAt <= q.to!);
    if (q.q) {
      const term = q.q.toLowerCase();
      frames = frames.filter((f) => f.id.toLowerCase().includes(term));
    }
    return frames;
  });

  /** GET /api/frames/:id/image — public. `:id` is url-encoded "day/file". */
  app.get('/:id/image', async (req, reply) => {
    const raw = decodeURIComponent((req.params as { id: string }).id);
    if (raw.includes('..') || raw.split('/').length !== 2) return reply.badRequest('bad frame id');
    const full = path.join(FRAMES_DIR, raw);
    if (!existsSync(full)) return reply.notFound();
    reply
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'public, max-age=86400')
      .header('Content-Length', statSync(full).size);
    return reply.send(createReadStream(full));
  });

  /**
   * POST /api/frames/:id/crop — save a cropped copy of the source frame.
   * Body: { x, y, width, height } — pixel coords in the source image.
   * The crop is saved as a sibling PNG with `-crop-<x>_<y>_<w>_<h>-<iso>`
   * in the filename, listed just like any other frame. Original is
   * untouched. Operator uses this to isolate ticker / flasher regions.
   */
  app.post('/:id/crop', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const raw = decodeURIComponent((req.params as { id: string }).id);
    if (raw.includes('..') || raw.split('/').length !== 2) return reply.badRequest('bad frame id');
    const src = path.join(FRAMES_DIR, raw);
    if (!existsSync(src)) return reply.notFound();

    const body = (req.body ?? {}) as { x?: number; y?: number; width?: number; height?: number };
    const x = Math.max(0, Math.floor(Number(body.x)));
    const y = Math.max(0, Math.floor(Number(body.y)));
    const w = Math.max(1, Math.floor(Number(body.width)));
    const h = Math.max(1, Math.floor(Number(body.height)));
    if (!Number.isFinite(x) || !Number.isFinite(y) || w < 1 || h < 1) {
      return reply.badRequest('x, y, width, height required (positive integers)');
    }

    // Filename must match the standard frame pattern so listAllFrames
    // can parse channelId + timestamp back out. Previous scheme
    // (`<orig>-crop-x_y_w_h-<newIso>.png`) broke the strict ISO regex
    // and rendered every crop as "Invalid Date" + black thumbnail.
    // New scheme: same shape as a regular snapshot — the fact that
    // it's a crop is visible from the audit log + downloadable via
    // the standard image route.
    const [day, srcName] = raw.split('/') as [string, string];
    const chMatch0 = srcName.match(/^([^_]+)_/);
    const channelIdFromName = chMatch0 ? chMatch0[1]! : 'unknown';
    const capturedAt = new Date();
    const isoStamp = capturedAt.toISOString().replace(/[:.]/g, '-');
    const outName = `${channelIdFromName}_${isoStamp}.png`;
    const outFull = path.join(FRAMES_DIR, day, outName);

    // Use ffmpeg for the crop — same binary the rest of the pipeline
    // uses, no extra dep. crop=w:h:x:y filter, one frame in one frame out.
    const { spawn } = await import('node:child_process');
    const args = [
      '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-i', src,
      '-vf', `crop=${w}:${h}:${x}:${y}`,
      '-frames:v', '1',
      outFull,
    ];
    const ok = await new Promise<boolean>((resolve) => {
      const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      const to = setTimeout(() => { try { ff.kill('SIGKILL'); } catch { /* */ } }, 8000);
      ff.on('exit', (code) => {
        clearTimeout(to);
        resolve(code === 0 && existsSync(outFull) && statSync(outFull).size > 0);
      });
      ff.on('error', () => { clearTimeout(to); resolve(false); });
    });
    if (!ok) return reply.code(500).send({ error: 'crop failed' });

    const newId = `${day}/${outName}`;
    await app.audit(req, 'frame.crop', { meta: { src: raw, crop: { x, y, w, h }, out: newId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(201).send({
      id: newId,
      channelId: channelIdFromName,
      capturedAt: capturedAt.toISOString(),
      sizeBytes: statSync(outFull).size,
      imageUrl: `/api/frames/${encodeURIComponent(newId)}/image`,
      croppedFrom: raw,
    });
  });

  /** DELETE /api/frames/:id — remove a single frame. */
  app.delete('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const raw = decodeURIComponent((req.params as { id: string }).id);
    if (raw.includes('..') || raw.split('/').length !== 2) return reply.badRequest('bad frame id');
    const full = path.join(FRAMES_DIR, raw);
    if (existsSync(full)) unlinkSync(full);
    await app.audit(req, 'frame.delete', { meta: { id: raw } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(204).send();
  });

  /** DELETE /api/frames — wipe every saved frame. */
  app.delete('/', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    if (!existsSync(FRAMES_DIR)) return reply.code(204).send();
    let count = 0;
    for (const day of readdirSync(FRAMES_DIR)) {
      const dayDir = path.join(FRAMES_DIR, day);
      if (!statSync(dayDir).isDirectory()) continue;
      for (const f of readdirSync(dayDir)) {
        if (!f.endsWith('.png')) continue;
        try { unlinkSync(path.join(dayDir, f)); count++; } catch { /* */ }
      }
    }
    await app.audit(req, 'frame.delete-all', { meta: { count } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return { deleted: count };
  });
};

// Named exports (grabFrameFromHls / frameFilename / FRAMES_DIR) are the
// snapshot endpoint's contract — routes/channels.ts imports them for POST
// /api/channels/:id/snapshot so the capture path is shared without duplicating.
export default routes;
