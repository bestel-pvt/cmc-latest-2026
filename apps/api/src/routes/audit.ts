import type { FastifyPluginAsync } from 'fastify';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.authorize(['ADMIN']));

  app.get('/', async (req) => {
    const q = (req.query as { userId?: string; entityType?: string; entityId?: string; action?: string; limit?: string; before?: string }) ?? {};
    return app.prisma.auditLog.findMany({
      where: {
        ...(q.userId     ? { userId: q.userId } : {}),
        ...(q.entityType ? { entityType: q.entityType } : {}),
        ...(q.entityId   ? { entityId: q.entityId } : {}),
        ...(q.action     ? { action: { contains: q.action } } : {}),
        ...(q.before     ? { createdAt: { lt: new Date(q.before) } } : {}),
      },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: q.limit ? Math.min(Number(q.limit), 500) : 100,
    });
  });
};

export default routes;
