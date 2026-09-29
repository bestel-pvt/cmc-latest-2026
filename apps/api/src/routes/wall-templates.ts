import type { FastifyPluginAsync } from 'fastify';

/**
 * WallTemplate CRUD — server-persisted multiviewer layouts + tile
 * assignments. Shared across operators (Pak Navy team is small,
 * common named layouts). Replaces the pre-2026-09-17 client-side
 * localStorage store which was wiped on hard-refresh / browser
 * restart.
 */
const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => {
    return app.prisma.wallTemplate.findMany({
      orderBy: { updatedAt: 'desc' },
    });
  });

  app.post('/', async (req, reply) => {
    const b = (req.body as { name?: unknown; layoutId?: unknown; slots?: unknown }) ?? {};
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const layoutId = typeof b.layoutId === 'string' ? b.layoutId : '';
    if (!name) return reply.badRequest('name required');
    if (!layoutId) return reply.badRequest('layoutId required');
    if (!b.slots || typeof b.slots !== 'object') return reply.badRequest('slots required (object)');

    // Upsert by name — a re-save with the same name updates the existing
    // template rather than creating a duplicate (matches how the client
    // "save" flow feels — one entry per name).
    const saved = await app.prisma.wallTemplate.upsert({
      where: { name },
      update: { layoutId, slots: b.slots as never },
      create: { name, layoutId, slots: b.slots as never },
    });
    await app.audit(req, 'wall-template.save', { entityType: 'WallTemplate', entityId: saved.id, meta: { name, layoutId } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return saved;
  });

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      await app.prisma.wallTemplate.delete({ where: { id } });
    } catch {
      return reply.notFound();
    }
    await app.audit(req, 'wall-template.delete', { entityType: 'WallTemplate', entityId: id });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(204).send();
  });
};

export default routes;
