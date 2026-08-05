import type { FastifyPluginAsync } from 'fastify';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Public download endpoint for the CMC Viewer desktop app.
 *
 * Files land at /opt/demp/data/downloads/ from the packaging step. This
 * route is intentionally NOT behind `authenticate` — the .exe is meant to
 * be linked from the app for operators to click through, and requiring a
 * bearer would break the vanilla <a href> download flow.
 */

const DOWNLOADS_DIR = resolve(process.env.DEMP_DOWNLOADS_DIR ?? './data/downloads');

interface Build {
  platform: 'windows' | 'linux';
  filename: string;
  contentType: string;
  notes?: string;
}

const BUILDS: Build[] = [
  {
    platform: 'windows',
    filename: 'CMC-Viewer.exe',
    contentType: 'application/vnd.microsoft.portable-executable',
    notes: 'Windows 64-bit — bundles VLC + all deps. Just double-click.',
  },
  // Linux build intentionally excluded — operator asked to focus on
  // Windows only.
];

const routes: FastifyPluginAsync = async (app) => {
  app.get('/desktop-viewer/manifest', async () => {
    const items = BUILDS.map((b) => {
      const p = `${DOWNLOADS_DIR}/${b.filename}`;
      if (!existsSync(p)) return null;
      const st = statSync(p);
      return {
        platform: b.platform,
        filename: b.filename,
        sizeBytes: st.size,
        builtAt: st.mtime.toISOString(),
        notes: b.notes,
        url: `/api/downloads/desktop-viewer/${b.filename}`,
      };
    }).filter(Boolean);

    if (items.length === 0) return { available: false, builds: [] };
    // Legacy shape (Windows-only) kept for existing callers
    const win = items.find((i) => i && i.platform === 'windows');
    return {
      available: true,
      platform: win?.platform ?? items[0]!.platform,
      filename: win?.filename ?? items[0]!.filename,
      sizeBytes: win?.sizeBytes ?? items[0]!.sizeBytes,
      builtAt:   win?.builtAt   ?? items[0]!.builtAt,
      url:       win?.url       ?? items[0]!.url,
      builds: items,
    };
  });

  for (const b of BUILDS) {
    app.get(`/desktop-viewer/${b.filename}`, async (_req, reply) => {
      const p = `${DOWNLOADS_DIR}/${b.filename}`;
      if (!existsSync(p)) return reply.notFound(`${b.filename} not built yet`);
      const st = statSync(p);
      reply
        .header('Content-Type', b.contentType)
        .header('Content-Length', st.size)
        .header('Content-Disposition', `attachment; filename="${b.filename}"`);
      return reply.send(createReadStream(p));
    });
  }

  // Linux one-liner installer served as plain text so
  //   curl -sL http://.../install-linux.sh | sudo bash
  // just works.
  app.get('/desktop-viewer/install-linux.sh', async (_req, reply) => {
    const p = `${DOWNLOADS_DIR}/install-linux.sh`;
    if (!existsSync(p)) return reply.notFound('install-linux.sh not published');
    const st = statSync(p);
    reply
      .header('Content-Type', 'text/x-shellscript; charset=utf-8')
      .header('Content-Length', st.size);
    return reply.send(createReadStream(p));
  });

  // Icon used by the .desktop launcher the installer writes.
  app.get('/desktop-viewer/demp.png', async (_req, reply) => {
    const p = `${DOWNLOADS_DIR}/demp.png`;
    if (!existsSync(p)) return reply.notFound();
    const st = statSync(p);
    reply
      .header('Content-Type', 'image/png')
      .header('Content-Length', st.size)
      .header('Cache-Control', 'public, max-age=86400');
    return reply.send(createReadStream(p));
  });
};

export default routes;
