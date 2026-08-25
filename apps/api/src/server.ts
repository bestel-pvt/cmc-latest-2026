import Fastify from 'fastify';

// Prisma returns BigInt for INT8 columns (e.g. RecordingSegment.sizeBytes).
// Fastify's default JSON serializer can't handle BigInt and 500s.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(BigInt.prototype as any).toJSON = function () { return this.toString(); };
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { resolve as pathResolve, join as pathJoin } from 'node:path';
import { readFile } from 'node:fs/promises';

import { env } from './env.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import auditPlugin from './plugins/audit.js';
import wsPlugin from './plugins/ws.js';

import authRoutes from './routes/auth.js';
import channelsRoutes from './routes/channels.js';
import framesRoutes from './routes/frames.js';
import sourcesRoutes from './routes/sources.js';
import recordingsRoutes from './routes/recordings.js';
import clipsRoutes from './routes/clips.js';
import usersRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';
import dashboardRoutes from './routes/dashboard.js';
// Removed in Phase 3.1.5 — CMC has no user-facing settings (change-
// password lives under /api/auth), no legal-holds workflow, no
// desktop-viewer downloads. Files kept in the repo for now in case a
// future fork needs them.

async function main() {
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } } }
        : true,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: true, credentials: true });
  await app.register(sensible);
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    // Skip HLS playlist + segment traffic. hls.js on 30+ tiles refetches
    // live.m3u8 every ~half-segment (2-3 s) plus each new .ts file, which
    // easily blows past 300 req/min under normal wall usage. HLS is
    // static file serving, not application logic — no rate-limit needed.
    allowList: (req) => (req.raw.url ?? '').startsWith('/hls/'),
  });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
  await app.register(jwt, {
    secret: { private: env.JWT_SECRET, public: env.JWT_SECRET } as unknown as string,
    sign: { expiresIn: env.JWT_ACCESS_TTL },
  });
  await app.register(websocket);

  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(auditPlugin);
  await app.register(wsPlugin);

  app.get('/health', async () => ({
    ok: true,
    service: 'cmc-api',
    ts: new Date().toISOString(),
  }));

  await app.register(authRoutes,        { prefix: '/api/auth' });
  await app.register(dashboardRoutes,   { prefix: '/api/dashboard' });
  await app.register(channelsRoutes,    { prefix: '/api/channels' });
  await app.register(framesRoutes,      { prefix: '/api/frames' });
  await app.register(sourcesRoutes,     { prefix: '/api/sources' });
  await app.register(recordingsRoutes,  { prefix: '/api/recordings' });
  await app.register(clipsRoutes,       { prefix: '/api/clips' });
  await app.register(usersRoutes,       { prefix: '/api/users' });
  await app.register(auditRoutes,       { prefix: '/api/audit' });

  // Live HLS static-file serving.
  // services/live-hls writes per-channel `<HLS_DIR>/<slug>/live.m3u8` +
  // `.ts` segments; the browser video wall fetches from
  //   http://<api-host>:<api-port>/hls/<slug>/live.m3u8
  // No auth on these — the m3u8/ts endpoints are safe to serve openly
  // on the LAN; a defence deployment behind a private VLAN doesn't need
  // per-tile JWT juggling here. CORS is already open via the cors plugin
  // above.
  const HLS_DIR = pathResolve(process.env.HLS_DIR ?? './data/hls');

  // Per-slug m3u8 cache with TWO purposes:
  //   (a) hot-path coalescing — 30 tiles polling every ~3 s = ~10
  //       req/s to the same handful of slugs. Without a short-TTL
  //       cache, every request hits the libuv thread pool for a
  //       readFile; the pool is 4 workers by default and spikes
  //       under sustained load produced 3–5 s latencies (measured
  //       2026-08-25 on the wall). Long-latency responses held
  //       browser sockets open, the Windows TCP accept queue
  //       overflowed, and the kernel started refusing new
  //       connections with ERR_CONNECTION_REFUSED — the "wall
  //       stuck out of nowhere" symptom.
  //   (b) gap-fill during live-hls ffmpeg age-recycle — when
  //       live.m3u8 is missing from disk for ~5–10 s, serve the
  //       last-known-good body instead of a 404 so hls.js doesn't
  //       latch the tile into permanent-failure.
  //
  // Fast path: cached body <= HOT_TTL_MS old → return without touching
  // disk. Coalesces 30 concurrent CNN polls into 1 disk read.
  // Slow path (cache stale): readFile fresh. Cache the result.
  // Fallback (readFile fails): serve cache up to GAP_TTL_MS old.
  const M3U8_CACHE = new Map<string, { body: Buffer; ts: number }>();
  const GAP_TTL_MS = 60_000;
  const REFRESH_MS = 500;

  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

  // Background refresh: once a slug has been requested, we keep its
  // m3u8 fresh in memory every REFRESH_MS. The request handler serves
  // PURELY from cache — zero disk I/O in the hot path.  Prior design
  // did `await readFile` on every request; under sustained 30-tile
  // wall load Windows disk-stall spikes pushed tail latencies to
  // 4-5 s, which held browser sockets long enough to overflow the
  // TCP accept queue and produce sporadic ERR_CONNECTION_REFUSED
  // on the wall (reported 2026-08-25). Now: 30 tiles polling every
  // ~3 s produce ~10 memory-cache hits/s (near-zero cost) while
  // ONE background refresher does ~2 reads/s per slug — even a full
  // pool of 4 libuv workers handles that trivially.
  setInterval(async () => {
    for (const slug of M3U8_CACHE.keys()) {
      try {
        const body = await readFile(pathJoin(HLS_DIR, slug, 'live.m3u8'));
        M3U8_CACHE.set(slug, { body, ts: Date.now() });
      } catch { /* keep last-known-good; the request-handler gap-fill
                  window still applies below */ }
    }
  }, REFRESH_MS).unref();

  app.get<{ Params: { slug: string } }>('/hls/:slug/live.m3u8', async (req, reply) => {
    const { slug } = req.params;
    if (!SLUG_RE.test(slug)) return reply.code(404).send();

    reply
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .header('Content-Type', 'application/vnd.apple.mpegurl');

    const cached = M3U8_CACHE.get(slug);
    if (cached) {
      // Fresh from background refresh (< REFRESH_MS old), OR stale but
      // still inside gap-fill window (ffmpeg age-recycle can leave the
      // file missing for ~5-10 s; we serve the last-known-good so
      // hls.js doesn't latch the tile into permanent failure).
      if (Date.now() - cached.ts < GAP_TTL_MS) return reply.send(cached.body);
    }
    // First request for this slug — sync fill so we don't return 404
    // just because the background refresher hasn't touched it yet.
    try {
      const body = await readFile(pathJoin(HLS_DIR, slug, 'live.m3u8'));
      M3U8_CACHE.set(slug, { body, ts: Date.now() });
      return reply.send(body);
    } catch {
      return reply.code(404).send();
    }
  });

  await app.register(fastifyStatic, {
    root: HLS_DIR,
    prefix: '/hls/',
    decorateReply: false,
    cacheControl: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        // Live playlist rewrites every segment — never cache.
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      } else if (filePath.endsWith('.ts')) {
        // Segments are immutable once written; short cache is fine.
        res.setHeader('Cache-Control', 'public, max-age=10');
        res.setHeader('Content-Type', 'video/mp2t');
      }
    },
  });
  app.log.info(`serving live HLS from ${HLS_DIR} at /hls/`);

  const shutdown = async (sig: string) => {
    app.log.info({ sig }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT',  () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
  app.log.info(`CMC API listening on http://0.0.0.0:${env.API_PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
