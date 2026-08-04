import type { FastifyPluginAsync } from 'fastify';
import { upsertChannelSchema } from '@cmc/shared';

/**
 * Both stream URLs for a channel. Operators pick whichever their
 * network supports:
 *   - udp:  low-latency multicast; ONLY works on the same broadcast
 *           domain as the server (same LAN switch). Multicast does not
 *           cross Tailscale / most VPNs / most routers.
 *   - rtsp: TCP-based; works from any network the server is reachable
 *           on (including Tailscale peers, remote sites). Slightly
 *           higher latency, one connection per viewer.
 */
function dempUrlsFor(slug: string, port: number | null | undefined): {
  udp: string | null; rtsp: string; rtspLo: string;
} {
  const host = process.env.PUBLIC_STREAM_HOST ?? '100.105.45.112';
  let udp: string | null = null;
  if (port) {
    const octet = 100 + (port % 155);
    udp = `udp://@239.7.${octet}.${port & 0xff}:${port}`;
  }
  // rtsp   = raw mediamtx path. UDP source is auto-joined (source
  //          field in mediamtx.yml), so this path is always warm and
  //          the first frame lands in ~200 ms — critical for VLC in
  //          the desktop viewer, which times out before the -lo
  //          transcoder cold-starts (~6-10 s) for channels not on
  //          runOnInit.  30 Mbps HD.
  // rtspLo = 480p on-demand transcode. Cheap on bandwidth (~600 kbps)
  //          and CPU (auto-terminates 30 s after last viewer). Only
  //          Dunya / 24 keep this warm; other channels take a few
  //          seconds to spin up. Reserve for browser preview / large
  //          walls where bandwidth matters more than start-up time.
  return {
    udp,
    rtsp:   `rtsp://${host}:8554/${slug}`,
    rtspLo: `rtsp://${host}:8554/${slug}-lo`,
  };
}

/** Back-compat single-URL helper (used by CSV export). Prefers UDP so
 * exported LAN operator sheets keep multicast; falls back to RTSP. */
function dempUrlFor(slug: string, port?: number | null): string | null {
  const { udp, rtsp } = dempUrlsFor(slug, port ?? null);
  return udp ?? rtsp;
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

    // Attach hot health from Redis (best-effort). When the failover
    // controller isn't writing scores, fall back to mediamtx path
    // readiness — a channel whose source is actively pushing packets
    // shouldn't be tagged IDLE.
    const mtxReady: Record<string, boolean> = {};
    try {
      const { request } = await import('undici');
      const mtxUrl = process.env.MEDIAMTX_API_URL ?? 'http://localhost:9997';
      const r = await request(`${mtxUrl}/v3/paths/list?itemsPerPage=1000`);
      if (r.statusCode < 400) {
        const body = await r.body.json() as { items?: Array<{ name: string; ready?: boolean; bytesReceived?: number }> };
        for (const p of body.items ?? []) {
          if (p.ready && (p.bytesReceived ?? 0) > 0) mtxReady[p.name] = true;
        }
      }
    } catch { /* mediamtx offline */ }

    const withHealth = await Promise.all(channels.map(async (c) => {
      const state = await app.redis.hgetall(`demp:ch:${c.id}:state`);
      // Same MAX rule as the dashboard route — see dashboard.ts comment.
      const redisScore = state.score !== undefined && state.score !== '' ? Number(state.score) : null;
      const mtxScore = mtxReady[c.slug] ? 0.9 : null;
      let score: number | null = null;
      if (redisScore !== null && mtxScore !== null) score = Math.max(redisScore, mtxScore);
      else score = redisScore ?? mtxScore;
      const urls = dempUrlsFor(c.slug, c.dempOutputPort);
      // "online" is what desktop viewer + web UI use to render a
      // channel as pickable vs greyed-out. A raw mediamtx path can be
      // in a state where mtxReady=true but bytes-received=0 — meaning
      // the transport joined the multicast group but the source isn't
      // publishing. We treat that as offline: only paths with a real
      // failover-controller score or with mtxReady && recent bytes
      // count as online.
      const online = (score !== null && score > 0.2) || Boolean(mtxReady[c.slug]);
      return {
        ...c,
        online,
        dempOutputUrl: urls.udp ?? urls.rtsp,
        dempOutputUrlUdp: urls.udp,
        dempOutputUrlRtsp: urls.rtsp,
        dempOutputUrlRtspLo: urls.rtspLo,
        runtime: {
          activeSourceId: state.activeSourceId ?? null,
          lastSwitchAt:   state.lastSwitchAt ? Number(state.lastSwitchAt) : null,
          score,
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
  // Prefers the direct RTSP path (MediaMTX exposes rtsp://localhost:8554/<slug>
  // as soon as a source is publishing — no HLS packaging delay). Buffers the
  // full PNG in memory before responding, so Fastify sends the correct
  // Content-Length and we never emit a headers-then-empty-body response.
  app.get('/:id/frame.png', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ch = await app.prisma.channel.findUnique({
      where: { id },
      include: { sources: { orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }] } },
    });
    if (!ch) return reply.notFound();

    const { spawn } = await import('node:child_process');
    const rtspSrc = `rtsp://127.0.0.1:8554/${ch.slug}`;
    const primary = ch.sources[0];
    let udpSrc: string | null = null;
    if (primary && primary.kind === 'UDP') {
      let u = primary.url.trim();
      if (u.includes('://') && !u.split('://', 2)[1]!.startsWith('@')) {
        const [proto, rest] = u.split('://', 2);
        u = `${proto!.toLowerCase()}://@${rest}`;
      }
      udpSrc = `${u}?fifo_size=100000&overrun_nonfatal=1&timeout=5000000`;
    }

    async function grab(src: string, isMpegTs: boolean, timeoutMs: number): Promise<Buffer | null> {
      return await new Promise((resolve) => {
        const args = [
          '-y', '-hide_banner', '-nostdin', '-loglevel', 'error',
          '-analyzeduration', '5M', '-probesize', '5M',
          '-err_detect', 'ignore_err',
          '-fflags', '+discardcorrupt+igndts+genpts',
          ...(src.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []),
          ...(isMpegTs ? ['-f', 'mpegts'] : []),
          '-i', src,
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

    // UDP source direct first (satellite feed — most reliable),
    // fall back to mediamtx RTSP path.
    let png: Buffer | null = null;
    if (udpSrc) png = await grab(udpSrc, true, 10000);
    if (!png) png = await grab(rtspSrc, false, 8000);
    if (!png) return reply.code(503).send({ error: 'no live signal — unable to capture a freeze frame' });

    return reply
      .code(200)
      .header('Content-Type', 'image/png')
      .header('Cache-Control', 'no-store')
      .header('Content-Length', png.length)
      .send(png);
  });

  // CSV export of channels + sources + DEMP output URLs.
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
      const urls = dempUrlsFor(c.slug, c.dempOutputPort);
      const url = urls.udp ?? urls.rtsp;
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

    // Attach per-source health from Redis + computed DEMP UDP URL
    const sourcesWithHealth = await Promise.all(channel.sources.map(async (s) => {
      const raw = await app.redis.get(`demp:src:${s.id}:health`);
      return { ...s, health: raw ? JSON.parse(raw) : null };
    }));
    const state = await app.redis.hgetall(`demp:ch:${channel.id}:state`);
    const _urls = dempUrlsFor(channel.slug, channel.dempOutputPort);
    return {
      ...channel,
      dempOutputUrl: _urls.udp ?? _urls.rtsp,
      dempOutputUrlUdp:  _urls.udp,
      dempOutputUrlRtsp: _urls.rtsp,
      dempOutputUrlRtspLo: _urls.rtspLo,
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

    await app.mediamtx.regenerateConfig().catch(() => {});
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

    // Demo-scope gate: AI features (ticker/flasher OCR, transcription) and
    // recording are ONLY allowed on the whitelisted demo channel (Dunya News).
    // Attempts to enable them elsewhere return a 403 with a clear message so
    // the UI can surface a toast, and the operator understands why the toggle
    // silently reverts.
    const DEMO_SCOPE_SLUG = process.env.DEMP_DEMO_SLUG ?? 'dunya-news';
    const enablingGatedFeature =
      data.aiFeaturesEnabled === true || data.recordingEnabled === true;
    if (enablingGatedFeature) {
      const existing = await app.prisma.channel.findUnique({
        where: { id },
        select: { slug: true, name: true },
      });
      if (!existing) return reply.notFound();
      if (existing.slug !== DEMO_SCOPE_SLUG) {
        return reply
          .code(403)
          .send({
            error: 'DEMO_SCOPE',
            message: `Demo scope: AI features and recording are only enabled on ${DEMO_SCOPE_SLUG}. ` +
                     `Contact DEMP admin to license additional channels.`,
            channel: existing.slug,
          });
      }
    }

    const updated = await app.prisma.channel.update({ where: { id }, data: data as never });
    await app.audit(req, 'channel.update', { entityType: 'Channel', entityId: id, meta: { fields: Object.keys(data) } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;

    await app.mediamtx.regenerateConfig().catch(() => {});
    return updated;
  });

  app.delete('/:id', { preHandler: [app.authorize(['ADMIN'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.prisma.channel.delete({ where: { id } });
    await app.audit(req, 'channel.delete', { entityType: 'Channel', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    await app.mediamtx.regenerateConfig().catch(() => {});
    return reply.code(204).send();
  });

  // Force a source switch (operator override)
  app.post('/:id/switch', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { sourceId } = (req.body ?? {}) as { sourceId?: string };
    if (!sourceId) return reply.badRequest('sourceId required');
    const src = await app.prisma.source.findFirst({ where: { id: sourceId, channelId: id } });
    if (!src) return reply.notFound();
    const ch = await app.prisma.channel.findUnique({ where: { id } });
    if (!ch) return reply.notFound();

    await app.redis.hset(`demp:ch:${id}:state`, {
      activeSourceId: src.id,
      lastSwitchAt: Date.now(),
      forcedBy: req.user.id,
    });
    await app.mediamtx.setActiveSource(ch.slug, src.url, src.kind);
    await app.redisPub.publish('demp:events:source-switch', JSON.stringify({
      type: 'channel.source-switch', channelId: id, toSourceId: src.id, reason: 'operator-override', at: Date.now(),
    }));
    await app.audit(req, 'channel.source-switch', { entityType: 'Channel', entityId: id, meta: { sourceId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return { ok: true };
  });
};

export default routes;
