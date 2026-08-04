import type { FastifyPluginAsync } from 'fastify';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { createClipSchema } from '@cmc/shared';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const q = (req.query as { channelId?: string; status?: string; from?: string; to?: string; limit?: string }) ?? {};
    return app.prisma.clip.findMany({
      where: {
        ...(q.channelId ? { channelId: q.channelId } : {}),
        ...(q.status    ? { status: q.status as never } : {}),
        ...(q.from || q.to ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to   ? { lte: new Date(q.to) }   : {}),
          },
        } : {}),
      },
      include: { channel: { select: { id: true, name: true, slug: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit ? Math.min(Number(q.limit), 500) : 100,
    });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const clip = await app.prisma.clip.findUnique({
      where: { id },
      include: { channel: true, createdBy: { select: { id: true, name: true, email: true } } },
    });
    if (!clip) return reply.notFound();
    return clip;
  });

  app.post('/', async (req, reply) => {
    const parsed = createClipSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const d = parsed.data;

    const wm = d.watermarkText ?? `${req.user.email} · ${new Date().toISOString()}`;
    const created = await app.prisma.clip.create({
      data: {
        channelId: d.channelId,
        startAt:   new Date(d.startAt),
        endAt:     new Date(d.endAt),
        title:     d.title,
        notes:     d.notes ?? null,
        format:    d.format,
        resolution: d.resolution,
        watermarkText: wm,
        status: 'QUEUED',
        createdById: req.user.id,
      },
    });

    // Enqueue clip render via Redis pub/sub — the recording service picks it up.
    await app.redisPub.publish('demp:jobs:clip', JSON.stringify({ clipId: created.id }));

    await app.audit(req, 'clip.create', { entityType: 'Clip', entityId: created.id, meta: { channelId: d.channelId, startAt: d.startAt, endAt: d.endAt } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(202).send(created);
  });

  app.get('/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const clip = await app.prisma.clip.findUnique({ where: { id } });
    if (!clip) return reply.notFound();
    if (clip.status !== 'READY' || !clip.path || !existsSync(clip.path)) {
      return reply.code(409).send({ error: 'clip not ready', status: clip.status });
    }
    const stat = statSync(clip.path);
    reply
      .header('Content-Length', stat.size)
      .header('Content-Type', clip.format === 'MP4' ? 'video/mp4' : 'application/octet-stream')
      .header('Content-Disposition', `attachment; filename="${clip.title.replace(/[^a-z0-9-_]+/gi, '_')}.${clip.format.toLowerCase()}"`);
    await app.audit(req, 'clip.download', { entityType: 'Clip', entityId: id });
    return reply.send(createReadStream(clip.path));
  });

  app.delete('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.prisma.clip.delete({ where: { id } });
    await app.audit(req, 'clip.delete', { entityType: 'Clip', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(204).send();
  });
};

export default routes;
