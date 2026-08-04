import type { FastifyPluginAsync } from 'fastify';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => {
    const rows = await app.prisma.setting.findMany();
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  });

  app.patch('/', { preHandler: [app.authorize(['ADMIN'])] }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') return reply.badRequest();
    const results: Array<{ key: string; value: unknown }> = [];
    for (const [key, value] of Object.entries(body)) {
      const s = await app.prisma.setting.upsert({
        where: { key },
        update: { value: value as never },
        create: { key, value: value as never },
      });
      results.push({ key: s.key, value: s.value });
    }
    await app.audit(req, 'settings.update', { meta: { keys: Object.keys(body) } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return { ok: true, updated: results };
  });
};

export default routes;
