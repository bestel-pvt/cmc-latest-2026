import type { FastifyPluginAsync } from 'fastify';
import { upsertChannelSchema } from '@cmc/shared';
import { FRAMES_DIR, frameFilename, grabFrameFromHls } from './frames.js';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Whitelist of channel fields the API returns. CMC has NO AI features,
 * NO ticker/flasher OCR, NO MediaMTX rebroadcast, and NO failover
 * controller — the DB still carries those columns from the DEMP schema
 * but they must not appear in API responses (they confuse the operator
 * UI). Every channel-returning endpoint uses this projection.
 */
type Sourceish = { url: string; kind: string };
function projectChannel<T extends {
  id: string; slug: string; name: string; logoUrl: string | null;
  category: string; language: string; active: boolean;
  recordingEnabled: boolean; notes: string | null;
  createdAt: Date; updatedAt: Date;
  sources?: Sourceish[];
}>(c: T): {
  id: string; slug: string; name: string; logoUrl: string | null;
  category: string; language: string; active: boolean;
  recordingEnabled: boolean; notes: string | null;
  createdAt: Date; updatedAt: Date;
  sourceUrl: string | null; sourceKind: string | null;
} {
  const primary = c.sources && c.sources.length > 0 ? c.sources[0]! : null;
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    logoUrl: c.logoUrl,
    category: c.category,
    language: c.language,
    active: c.active,
    recordingEnabled: c.recordingEnabled,
    notes: c.notes,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    sourceUrl: primary?.url ?? null,
    sourceKind: primary?.kind ?? null,
  };
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (req, reply) => {
    // Channel logo GETs are public — plain <img src> tags in the web
    // wall / channel list can't attach a JWT bearer, and the logos
    // aren't sensitive. Everything else in this router still requires
    // authentication.
    if (req.method === 'GET' && /^\/api\/channels\/[^/]+\/logo(\?|$)/.test(req.raw.url ?? '')) {
      return;
    }
    return app.authenticate(req, reply);
  });

  app.get('/', async (req) => {
    const q = (req.query as { q?: string; category?: string; language?: string; active?: string }) ?? {};
    const where: Record<string, unknown> = {};
    if (q.q) where.OR = [
      { name: { contains: q.q, mode: 'insensitive' } },
      { slug: { contains: q.q, mode: 'insensitive' } },
    ];
    if (q.category) where.category = q.category;
    if (q.language) where.language = q.language;
    if (q.active === 'true' || q.active === 'false') where.active = q.active === 'true';

    const channels = await app.prisma.channel.findMany({
      where,
      // CMC = 1 source per channel (no failover). We still include the
      // sources relation so projectChannel can flatten to sourceUrl.
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }], take: 1 } },
      orderBy: { name: 'asc' },
    });
    return channels.map(projectChannel);
  });

  /**
   * Upload / replace a channel logo (png / webp / jpeg / jpg).
   * Stored under $DATA_DIR/logos/{channelId}.{ext} and served via
   * GET /api/channels/:id/logo. The public URL is written to Channel.logoUrl.
   */
  app.post('/:id/logo', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const ch = await app.prisma.channel.findUnique({ where: { id } });
    if (!ch) return reply.notFound();
    const file = await req.file();
    if (!file) return reply.badRequest('image required');
    const mime = file.mimetype.toLowerCase();
    const ext = mime.includes('png') ? 'png' :
                mime.includes('webp') ? 'webp' :
                mime.includes('jpeg') || mime.includes('jpg') ? 'jpg' : null;
    if (!ext) return reply.badRequest('unsupported format — use png, webp, jpeg or jpg');

    const { mkdirSync, createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const path = await import('node:path');
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
    const dir = path.join(dataDir, 'logos');
    mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${id}.${ext}`);
    await pipeline(file.file, createWriteStream(outPath));

    const publicUrl = `/api/channels/${id}/logo?v=${Date.now()}`;
    const updated = await app.prisma.channel.update({ where: { id }, data: { logoUrl: publicUrl } });
    await app.audit(req, 'channel.logo.upload', { entityType: 'Channel', entityId: id, meta: { ext, size: (file.file as unknown as { bytesRead?: number }).bytesRead ?? null } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return { logoUrl: updated.logoUrl };
  });

  app.get('/:id/logo', async (req, reply) => {
    const { id } = req.params as { id: string };
    const path = await import('node:path');
    const { existsSync, createReadStream, statSync } = await import('node:fs');
    const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');
    const dir = path.join(dataDir, 'logos');
    for (const ext of ['png', 'webp', 'jpg']) {
      const p = path.join(dir, `${id}.${ext}`);
      if (existsSync(p)) {
        const type = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        // URL already carries ?v=<timestamp> from the upload endpoint,
        // so every logo URL is unique per version — safe to tell the
        // browser this bytes-for-this-URL will never change. Was 300 s
        // (5 min) which meant the channels page re-fetched all 30
        // logos on every reload and queued them 6 at a time behind
        // HTTP/1.1's per-origin connection cap. That was the 6-second
        // logo load the operator reported.
        reply
          .header('Content-Type', type)
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .header('Content-Length', statSync(p).size);
        return reply.send(createReadStream(p));
      }
    }
    return reply.notFound('no logo');
  });

  // Latest freeze-frame of the live channel — used by the ticker/flasher region editor.
  //
  // Grabs directly from the primary source (UDP multicast, RTSP, SRT, …) —
  // no MediaMTX in the loop. Buffers the full PNG in memory before responding
  // so Fastify sends the correct Content-Length and we never emit a
  // headers-then-empty-body response.
  app.get('/:id/frame.png', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ch = await app.prisma.channel.findUnique({
      where: { id },
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
    });
    if (!ch) return reply.notFound();

    const { spawn } = await import('node:child_process');
    const primary = ch.sources[0];
    if (!primary) return reply.code(503).send({ error: 'no source configured for this channel' });

    let src = primary.url.trim();
    const isUdpLike = primary.kind === 'UDP' || primary.kind === 'RTP';
    if (isUdpLike) {
      if (src.includes('://') && !src.split('://', 2)[1]!.startsWith('@')) {
        const [proto, rest] = src.split('://', 2);
        src = `${proto!.toLowerCase()}://@${rest}`;
      }
      if (!src.includes('?')) {
        src = `${src}?fifo_size=100000&overrun_nonfatal=1&timeout=5000000`;
      }
    }

    async function grab(source: string, isMpegTs: boolean, timeoutMs: number): Promise<Buffer | null> {
      return await new Promise((resolve) => {
        const args = [
          '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-analyzeduration', '5M', '-probesize', '5M',
          '-err_detect', 'ignore_err',
          '-fflags', '+discardcorrupt+igndts+genpts',
          ...(source.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []),
          ...(isMpegTs ? ['-f', 'mpegts'] : []),
          '-i', source,
          '-frames:v', '1', '-q:v', '2', '-f', 'image2', '-vcodec', 'png',
          'pipe:1',
        ];
        const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks: Buffer[] = [];
        let killed = false;
        const to = setTimeout(() => { killed = true; try { ff.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
        ff.stdout.on('data', (b: Buffer) => chunks.push(b));
        ff.on('error', () => { clearTimeout(to); resolve(null); });
        ff.on('exit', (code) => {
          clearTimeout(to);
          if (killed || code !== 0 || chunks.length === 0) return resolve(null);
          resolve(Buffer.concat(chunks));
        });
      });
    }

    const png = await grab(src, isUdpLike, 10000);
    if (!png) return reply.code(503).send({ error: 'no live signal — unable to capture a freeze frame' });

    return reply
      .code(200)
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-store')
      .header('Content-Length', png.length)
      .send(png);
  });

  // CSV export — same trimmed shape as JSON (one row per channel, one source).
  app.get('/export.csv', async (_req, reply) => {
    const channels = await app.prisma.channel.findMany({
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }], take: 1 } },
      orderBy: { name: 'asc' },
    });
    const rows: string[] = ['channel_name,slug,category,language,active,recording_enabled,source_kind,source_url'];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for (const c of channels) {
      const src = c.sources[0];
      rows.push([c.name, c.slug, c.category, c.language, c.active, c.recordingEnabled, src?.kind ?? '', src?.url ?? ''].map(esc).join(','));
    }
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="cmc-channels-${new Date().toISOString().slice(0,10)}.csv"`);
    return rows.join('\n');
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = await app.prisma.channel.findUnique({
      where: { id },
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
    });
    if (!channel) return reply.notFound();
    // Detail response keeps the full sources array so the channel-detail
    // page can render its source-management UI (add / edit / delete).
    // Every other DEMP-only field (ticker/flasher/AI/demp/runtime) still
    // gets stripped by the same projection.
    return { ...projectChannel(channel), sources: channel.sources };
  });

  app.post('/', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const parsed = upsertChannelSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const created = await app.prisma.channel.create({
      data: parsed.data as never,
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }], take: 1 } },
    });
    await app.audit(req, 'channel.create', { entityType: 'Channel', entityId: created.id, meta: { slug: created.slug } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;

    return reply.code(201).send(projectChannel(created));
  });

  app.patch('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    // CMC: only fields that the operator UI can actually toggle. Ticker /
    // flasher / AI / demp fields are not editable here.
    for (const k of ['name', 'category', 'language', 'active', 'notes', 'logoUrl', 'recordingEnabled'] as const) {
      if (k in body) data[k] = body[k];
    }
    const updated = await app.prisma.channel.update({
      where: { id },
      data: data as never,
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }], take: 1 } },
    });
    // Recording-toggle trace: user reported "start from web, stop, doesn't
    // appear on recordings page". Log the PATCH so we can correlate with
    // recording.log entries when reproducing.
    if ('recordingEnabled' in data) {
      req.log.info({ channelId: id, slug: updated.slug, recordingEnabled: data.recordingEnabled }, 'recording toggle changed');
    }
    await app.audit(req, 'channel.update', { entityType: 'Channel', entityId: id, meta: { fields: Object.keys(data) } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return projectChannel(updated);
  });

  app.delete('/:id', { preHandler: [app.authorize(['ADMIN'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.prisma.channel.delete({ where: { id } });
    await app.audit(req, 'channel.delete', { entityType: 'Channel', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(204).send();
  });

  /**
   * POST /api/channels/:id/snapshot — capture the live frame right
   * now. Reads from the live-hls playlist on disk (~500 ms), writes a
   * PNG under DATA_DIR/frames/<yyyy-mm-dd>/, returns the frame metadata.
   */
  app.post('/:id/snapshot', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ch = await app.prisma.channel.findUnique({ where: { id }, select: { id: true, slug: true } });
    if (!ch) return reply.notFound();

    const HLS_DIR = path.resolve(process.env.HLS_DIR ?? './data/hls');
    const playlist = path.join(HLS_DIR, ch.slug, 'live.m3u8');
    if (!existsSync(playlist)) return reply.code(503).send({ error: 'no live playlist for this channel' });

    const capturedAt = new Date();
    const day = capturedAt.toISOString().slice(0, 10);
    const dayDir = path.join(FRAMES_DIR, day);
    mkdirSync(dayDir, { recursive: true });
    const filename = frameFilename(ch.id, capturedAt);
    const outPath = path.join(dayDir, filename);

    const ok = await grabFrameFromHls(playlist, outPath);
    if (!ok) return reply.code(500).send({ error: 'failed to capture frame' });

    const frameId = `${day}/${filename}`;
    await app.audit(req, 'frame.create', { entityType: 'Channel', entityId: ch.id, meta: { slug: ch.slug } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(201).send({
      id: frameId,
      channelId: ch.id,
      channelSlug: ch.slug,
      capturedAt: capturedAt.toISOString(),
      sizeBytes: statSync(outPath).size,
      imageUrl: `/api/frames/${encodeURIComponent(frameId)}/image`,
    });
  });

  // Force a source switch (operator override)
  app.post('/:id/switch', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sourceId } = (req.body ?? {}) as { sourceId?: string };
    if (!sourceId) return reply.badRequest('sourceId required');
    const src = await app.prisma.source.findFirst({ where: { id: sourceId, channelId: id } });
    if (!src) return reply.notFound();

    await app.redis.hset(`demp:ch:${id}:state`, {
      activeSourceId: src.id,
      lastSwitchAt: Date.now(),
      forcedBy: req.user.id,
    });
    await app.redisPub.publish('demp:events:source-switch', JSON.stringify({
      type: 'channel.source-switch', channelId: id, toSourceId: src.id, reason: 'operator-override', at: Date.now(),
    }));
    await app.audit(req, 'channel.source-switch', { entityType: 'Channel', entityId: id, meta: { sourceId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return { ok: true };
  });
};

export default routes;
