import type { FastifyPluginAsync } from 'fastify';
import { createLegalHoldSchema } from '@cmc/shared';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.authorize(['ADMIN', 'OPERATOR']));

  app.get('/', async () => {
    return app.prisma.legalHold.findMany({
      include: { channel: { select: { id: true, name: true, slug: true } }, createdBy: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.post('/', async (req, reply) => {
    const parsed = createLegalHoldSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);
    const created = await app.prisma.legalHold.create({
      data: {
        channelId: parsed.data.channelId ?? null,
        startsAt: new Date(parsed.data.startsAt),
        endsAt:   new Date(parsed.data.endsAt),
        reason:   parsed.data.reason,
        createdById: req.user.id,
      },
    });
    await app.audit(req, 'legalHold.create', { entityType: 'LegalHold', entityId: created.id, meta: { channelId: parsed.data.channelId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(201).send(created);
  });

  app.post('/:id/expire', async (req, reply) => {
    const { id } = req.params as { id: string };
    const updated = await app.prisma.legalHold.update({ where: { id }, data: { active: false } });
    await app.audit(req, 'legalHold.expire', { entityType: 'LegalHold', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return updated;
  });
};

export default routes;
