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
import { resolve as pathResolve } from 'node:path';

import { env } from './env.js';
import prismaPlugin from './plugins/prisma.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import auditPlugin from './plugins/audit.js';
import wsPlugin from './plugins/ws.js';

import authRoutes from './routes/auth.js';
import channelsRoutes from './routes/channels.js';
import sourcesRoutes from './routes/sources.js';
import recordingsRoutes from './routes/recordings.js';
import clipsRoutes from './routes/clips.js';
import usersRoutes from './routes/users.js';
import auditRoutes from './routes/audit.js';
import settingsRoutes from './routes/settings.js';
import legalHoldsRoutes from './routes/legalHolds.js';
import dashboardRoutes from './routes/dashboard.js';
import downloadsRoutes from './routes/downloads.js';

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
  await app.register(sourcesRoutes,     { prefix: '/api/sources' });
  await app.register(recordingsRoutes,  { prefix: '/api/recordings' });
  await app.register(clipsRoutes,       { prefix: '/api/clips' });
  await app.register(usersRoutes,       { prefix: '/api/users' });
  await app.register(auditRoutes,       { prefix: '/api/audit' });
  await app.register(settingsRoutes,    { prefix: '/api/settings' });
  await app.register(legalHoldsRoutes,  { prefix: '/api/legal-holds' });
  await app.register(downloadsRoutes,   { prefix: '/api/downloads' });

  // Live HLS static-file serving.
  // services/live-hls writes per-channel `<HLS_DIR>/<slug>/live.m3u8` +
  // `.ts` segments; the browser video wall fetches from
  //   http://<api-host>:<api-port>/hls/<slug>/live.m3u8
  // No auth on these — the m3u8/ts endpoints are safe to serve openly
  // on the LAN; a defence deployment behind a private VLAN doesn't need
  // per-tile JWT juggling here. CORS is already open via the cors plugin
  // above.
  const HLS_DIR = pathResolve(process.env.HLS_DIR ?? './data/hls');
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
