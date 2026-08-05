import type { FastifyPluginAsync } from 'fastify';
import { upsertChannelSchema } from '@cmc/shared';

/**
 * CMC stream URL for a channel. Only the UDP multicast rebroadcast is
 * emitted — the video-wall client joins that UDP group directly (no
 * MediaMTX / RTSP hop). Same-LAN VLC can attach to the same URL.
 */
function dempUrlsFor(_slug: string, port: number | null | undefined): {
  udp: string | null;
} {
  let udp: string | null = null;
  if (port) {
    const octet = 100 + (port % 155);
    udp = `udp://@239.7.${octet}.${port & 0xff}:${port}`;
  }
  return { udp };
}

/** Back-compat single-URL helper (used by CSV export). Returns the UDP
 * multicast URL when the channel has an output port, otherwise null. */
function dempUrlFor(slug: string, port?: number | null): string | null {
  return dempUrlsFor(slug, port ?? null).udp;
}

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

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
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
      orderBy: { name: 'asc' },
    });

    // Attach hot health from Redis (best-effort). Wall clients join UDP
    // multicast DIRECTLY, so the server has no rebroadcast-side signal
    // to consult — operator `active` + failover-controller score are the
    // only inputs.
    const withHealth = await Promise.all(channels.map(async (c) => {
      const state = await app.redis.hgetall(`demp:ch:${c.id}:state`);
      const redisScore = state.score !== undefined && state.score !== '' ? Number(state.score) : null;
      const urls = dempUrlsFor(c.slug, c.dempOutputPort);
      // "online" drives grey-out in the web UI. Trust the operator's
      // `active` flag as the source of truth; a positive failover-
      // controller score only ever ADDS confidence, never subtracts.
      // Channels that are genuinely dead get flipped to `active=false`
      // in the admin UI.
      const online = Boolean(c.active) || (redisScore !== null && redisScore > 0.2);
      return {
        ...c,
        online,
        dempOutputUrl: urls.udp,
        runtime: {
          activeSourceId: state.activeSourceId ?? null,
          lastSwitchAt:   state.lastSwitchAt ? Number(state.lastSwitchAt) : null,
          score: redisScore,
        },
      };
    }));
    return withHealth;
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
        reply
          .header('Content-Type', type)
          .header('Cache-Control', 'public, max-age=300')
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

  // CSV export of channels + sources + CMC output URLs.
  app.get('/export.csv', async (_req, reply) => {
    const channels = await app.prisma.channel.findMany({
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
      orderBy: { name: 'asc' },
    });
    const rows: string[] = [
      'channel_name,slug,category,language,active,ai_features_enabled,demp_output_url,source_name,source_kind,source_url,is_primary,priority',
    ];
    const esc = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    for (const c of channels) {
      const url = dempUrlFor(c.slug, c.dempOutputPort);
      if (c.sources.length === 0) {
        rows.push([c.name, c.slug, c.category, c.language, c.active, c.aiFeaturesEnabled, url, '', '', '', '', ''].map(esc).join(','));
      } else {
        for (const s of c.sources) {
          rows.push([c.name, c.slug, c.category, c.language, c.active, c.aiFeaturesEnabled, url,
                     s.notes ?? s.kind, s.kind, s.url, s.isPrimary, s.priority].map(esc).join(','));
        }
      }
    }
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="demp-channels-${new Date().toISOString().slice(0,10)}.csv"`);
    return rows.join('\n');
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const channel = await app.prisma.channel.findUnique({
      where: { id },
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
    });
    if (!channel) return reply.notFound();

    // Attach per-source health from Redis + computed CMC UDP URL
    const sourcesWithHealth = await Promise.all(channel.sources.map(async (s) => {
      const raw = await app.redis.get(`demp:src:${s.id}:health`);
      return { ...s, health: raw ? JSON.parse(raw) : null };
    }));
    const state = await app.redis.hgetall(`demp:ch:${channel.id}:state`);
    const _urls = dempUrlsFor(channel.slug, channel.dempOutputPort);
    return {
      ...channel,
      dempOutputUrl: _urls.udp,
      sources: sourcesWithHealth,
      runtime: {
        activeSourceId: state.activeSourceId ?? null,
        lastSwitchAt: state.lastSwitchAt ? Number(state.lastSwitchAt) : null,
        score: state.score ? Number(state.score) : null,
      },
    };
  });

  app.post('/', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const parsed = upsertChannelSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const created = await app.prisma.channel.create({ data: parsed.data as never });
    await app.audit(req, 'channel.create', { entityType: 'Channel', entityId: created.id, meta: { slug: created.slug } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;

    return reply.code(201).send(created);
  });

  app.patch('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const k of [
      'name', 'category', 'language', 'active', 'notes', 'logoUrl', 'aiFeaturesEnabled', 'recordingEnabled',
      'tickerCropRect', 'tickerPrimaryRect', 'tickerSecondaryRect', 'flasherLeftRect', 'flasherRightRect',
    ] as const) {
      if (k in body) data[k] = body[k];
    }

    // CMC: no demo scope gate — every channel can toggle recording +
    // clipping freely.
    const updated = await app.prisma.channel.update({ where: { id }, data: data as never });
    await app.audit(req, 'channel.update', { entityType: 'Channel', entityId: id, meta: { fields: Object.keys(data) } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;

    return updated;
  });

  app.delete('/:id', { preHandler: [app.authorize(['ADMIN'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.prisma.channel.delete({ where: { id } });
    await app.audit(req, 'channel.delete', { entityType: 'Channel', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(204).send();
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
