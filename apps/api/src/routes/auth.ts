import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { loginSchema } from '@cmc/shared';

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post('/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.badRequest(parsed.error.message);

    const user = await app.prisma.user.findUnique({ where: { email: parsed.data.email } });
    if (!user || user.disabledAt) {
      await app.audit(req, 'auth.login.failed', { meta: { email: parsed.data.email, reason: user ? 'disabled' : 'not-found' } });
      return reply.unauthorized('Invalid credentials');
    }
    const ok = await bcrypt.compare(parsed.data.password, user.passwordHash);
    if (!ok) {
      await app.audit(req, 'auth.login.failed', { meta: { email: parsed.data.email, reason: 'bad-password' } });
      return reply.unauthorized('Invalid credentials');
    }

    // 12 h access token: without explicit expiresIn the token uses the
    // @fastify/jwt default (short — session/15 min), which forced the
    // browser to re-authenticate every ~15 min. bcryptjs.compare is
    // synchronous pure-JS and takes ~450 ms per call on this hardware;
    // three concurrent logins (browser retry + multiple tabs) serialize
    // to 1.2–1.3 s each because the main event loop is blocked. 12 h
    // access + 7 d refresh means the browser hits /login once per shift,
    // not every 15 min — bcrypt pressure disappears in normal use.
    const accessToken  = await reply.jwtSign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '12h' });
    const refreshToken = await reply.jwtSign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '7d' });

    await app.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await app.audit(req, 'auth.login', { entityType: 'User', entityId: user.id });

    return { accessToken, refreshToken, user: { id: user.id, name: user.name, email: user.email, role: user.role } };
  });

  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = (req.body ?? {}) as { refreshToken?: string };
    if (!refreshToken) return reply.badRequest('missing refreshToken');
    try {
      const payload = app.jwt.verify(refreshToken) as { sub: string; email: string; role: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER' };
      const user = await app.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || user.disabledAt) return reply.unauthorized();
      const accessToken = await reply.jwtSign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: '12h' });
      return { accessToken };
    } catch {
      return reply.unauthorized('Invalid refresh token');
    }
  });

  app.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    const u = await app.prisma.user.findUnique({
      where: { id: req.user.id },
      select: { id: true, email: true, name: true, role: true, lastLoginAt: true },
    });
    return u;
  });

  app.post('/logout', { preHandler: [app.authenticate] }, async (req) => {
    await app.audit(req, 'auth.logout', { entityType: 'User', entityId: req.user.id });
    // Stateless JWT — client should drop tokens. Session revocation TBD (Phase 2).
    return { ok: true };
  });

  /** POST /api/auth/change-password — self-service password change for
   *  the currently signed-in user. Requires the current password to
   *  guard against session hijack. */
  app.post('/change-password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    if (!body.currentPassword || !body.newPassword) return reply.badRequest('currentPassword and newPassword required');
    if (body.newPassword.length < 8) return reply.badRequest('new password must be at least 8 characters');

    const user = await app.prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return reply.unauthorized();

    const ok = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!ok) {
      await app.audit(req, 'auth.change-password.failed', { entityType: 'User', entityId: user.id, meta: { reason: 'bad-current' } });
      return reply.unauthorized('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    await app.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await app.audit(req, 'auth.change-password', { entityType: 'User', entityId: user.id });
    return { ok: true };
  });
};

export default authRoutes;
