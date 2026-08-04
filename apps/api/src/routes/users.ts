import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { createUserSchema } from '@cmc/shared';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', app.authorize(['ADMIN']));

  app.get('/', async () => {
    return app.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, disabledAt: true, lastLoginAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  });

  app.post('/', async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string; name?: string; password?: string;
      role?: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';
      roleName?: string; permissions?: string[];
    };
    if (!body.email || !body.name || !body.password) return reply.badRequest('email, name, password required');
    const role = body.role ?? 'VIEWER';
    const passwordHash = await bcrypt.hash(body.password, 12);
    const u = await app.prisma.user.create({
      data: {
        email: body.email,
        name: body.name,
        role,
        roleName: body.roleName?.trim() || null,
        permissions: Array.isArray(body.permissions) ? (body.permissions as never) : undefined,
        passwordHash,
      },
      select: { id: true, email: true, name: true, role: true, roleName: true, permissions: true },
    });
    await app.audit(req, 'user.create', { entityType: 'User', entityId: u.id, meta: { role: u.role, roleName: u.roleName } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return reply.code(201).send(u);
  });

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = req.body as Partial<{
      name: string; role: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER';
      roleName: string | null; permissions: string[] | null;
      disabled: boolean; password: string;
    }>;
    const data: Record<string, unknown> = {};
    if (body.name)                                data.name = body.name;
    if (body.role)                                data.role = body.role;
    if (body.roleName !== undefined)              data.roleName = body.roleName?.trim() || null;
    if (Array.isArray(body.permissions))          data.permissions = body.permissions as never;
    if (body.permissions === null)                data.permissions = null as never;
    if (typeof body.disabled === 'boolean')       data.disabledAt = body.disabled ? new Date() : null;
    if (body.password)                            data.passwordHash = await bcrypt.hash(body.password, 12);
    const u = await app.prisma.user.update({
      where: { id }, data,
      select: { id: true, email: true, name: true, role: true, roleName: true, permissions: true, disabledAt: true },
    });
    await app.audit(req, 'user.update', { entityType: 'User', entityId: id, meta: { fields: Object.keys(data) } });
    (req as unknown as { auditWritten?: boolean }).auditWritten = true;
    return u;
  });
};

export default routes;
