import type { FastifyPluginAsync } from 'fastify';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { createClipMergeSchema } from '@cmc/shared';

// Multi-clip merge: operator supplies N {channel, startAt, endAt}
// segments; worker renders each via the existing clip pipeline then
// concatenates in order into one mp4. Independent of the single-clip
// code path — no changes to /api/clips.
const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const q = (req.query as { status?: string; from?: string; to?: string; limit?: string }) ?? {};
    return app.prisma.clipMerge.findMany({
      where: {
        ...(q.status ? { status: q.status as never } : {}),
        ...(q.from || q.to ? {
          createdAt: {
            ...(q.from ? { gte: new Date(q.from) } : {}),
            ...(q.to   ? { lte: new Date(q.to)   } : {}),
          },
        } : {}),
      },
      include: {
        createdBy: { select: { id: true, name: true } },
        segments: {
          include: { channel: { select: { id: true, name: true, slug: true } } },
          orderBy: { orderIdx: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit ? Math.min(Number(q.limit), 500) : 100,
    });
  });

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await app.prisma.clipMerge.findUnique({
      where: { id },
      include: {
        createdBy: { select: { id: true, name: true, email: true } },
        segments: {
          include: { channel: { select: { id: true, name: true, slug: true } } },
          orderBy: { orderIdx: 'asc' },
        },
      },
    });
    if (!row) return reply.notFound();
    return row;
  });

  app.post('/', async (req, reply) => {
    const parsed = createClipMergeSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const d = parsed.data;

    const created = await app.prisma.clipMerge.create({
      data: {
        title: d.title,
        notes: d.notes ?? null,
        format: d.format,
        resolution: d.resolution,
        status: 'QUEUED',
        createdById: req.user.id,
        segments: {
          create: d.segments.map((seg, idx) => ({
            orderIdx: idx,
            channelId: seg.channelId,
            startAt: new Date(seg.startAt),
            endAt: new Date(seg.endAt),
          })),
        },
      },
      include: {
        segments: {
          include: { channel: { select: { id: true, name: true, slug: true } } },
          orderBy: { orderIdx: 'asc' },
        },
      },
    });

    // Matches the existing `demp:jobs:clip` channel naming — recording
     // service subscribes to both and dispatches to the right worker.
    await app.redisPub.publish('demp:jobs:clip-merge', JSON.stringify({ clipMergeId: created.id }));

    await app.audit(req, 'clipMerge.create', {
      entityType: 'ClipMerge',
      entityId: created.id,
      meta: { title: d.title, segments: d.segments.length },
    });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(202).send(created);
  });

  app.get('/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const row = await app.prisma.clipMerge.findUnique({ where: { id } });
    if (!row) return reply.notFound();
    if (row.status !== 'READY' || !row.path || !existsSync(row.path)) {
      return reply.code(409).send({ error: 'merge not ready', status: row.status });
    }
    const stat = statSync(row.path);
    reply
      .header('Content-Length', stat.size)
      .header('Content-Type', row.format === 'MP4' ? 'video/mp4' : 'application/octet-stream')
      .header(
        'Content-Disposition',
        `attachment; filename="${row.title.replace(/[^a-z0-9-_]+/gi, '_')}.${row.format.toLowerCase()}"`,
      );
    await app.audit(req, 'clipMerge.download', { entityType: 'ClipMerge', entityId: id });
    return reply.send(createReadStream(row.path));
  });

  app.delete('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.prisma.clipMerge.delete({ where: { id } });
    await app.audit(req, 'clipMerge.delete', { entityType: 'ClipMerge', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(204).send();
  });
};

export default routes;
