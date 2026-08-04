import type { FastifyPluginAsync } from 'fastify';
import { upsertSourceSchema } from '@cmc/shared';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async (req) => {
    const { channelId } = (req.query as { channelId?: string }) ?? {};
    return app.prisma.source.findMany({
      where: channelId ? { channelId } : undefined,
      orderBy: [{ isPrimary: 'desc' }, { priority: 'desc' }],
    });
  });

  app.post('/', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const parsed = upsertSourceSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const created = await app.prisma.source.create({ data: parsed.data });

    // If marked primary, unset primary on siblings
    if (parsed.data.isPrimary) {
      await app.prisma.source.updateMany({
        where: { channelId: parsed.data.channelId, id: { not: created.id } },
        data: { isPrimary: false },
      });
    }
    await app.audit(req, 'source.create', { entityType: 'Source', entityId: created.id, meta: { channelId: parsed.data.channelId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    await app.mediamtx.regenerateConfig().catch(() => {});
    return reply.code(201).send(created);
  });

  app.patch('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = upsertSourceSchema.partial().safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const updated = await app.prisma.source.update({ where: { id }, data: parsed.data });
    if (parsed.data.isPrimary) {
      await app.prisma.source.updateMany({
        where: { channelId: updated.channelId, id: { not: updated.id } },
        data: { isPrimary: false },
      });
    }
    await app.audit(req, 'source.update', { entityType: 'Source', entityId: id, meta: parsed.data });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    await app.mediamtx.regenerateConfig().catch(() => {});
    return updated;
  });

  app.delete('/:id', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    await app.prisma.source.delete({ where: { id } });
    await app.audit(req, 'source.delete', { entityType: 'Source', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    await app.mediamtx.regenerateConfig().catch(() => {});
    return reply.code(204).send();
  });

  // Reorder + set primary
  app.post('/reorder', { preHandler: [app.authorize(['ADMIN', 'OPERATOR'])] }, async (req, reply) => {
    const body = req.body as { channelId: string; order: string[]; primaryId?: string };
    if (!body?.channelId || !Array.isArray(body.order)) return reply.badRequest();
    await app.prisma.$transaction(async (tx) => {
      for (let i = 0; i < body.order.length; i++) {
        await tx.source.update({ where: { id: body.order[i]! }, data: { priority: body.order.length - i } });
      }
      if (body.primaryId) {
        await tx.source.updateMany({ where: { channelId: body.channelId, id: { not: body.primaryId } }, data: { isPrimary: false } });
        await tx.source.update({ where: { id: body.primaryId }, data: { isPrimary: true } });
      }
    });
    await app.audit(req, 'source.reorder', { entityType: 'Channel', entityId: body.channelId, meta: { order: body.order, primaryId: body.primaryId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    await app.mediamtx.regenerateConfig().catch(() => {});
    return { ok: true };
  });
};

export default routes;
