import fp from 'fastify-plugin';
import type { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    audit: (
      req: FastifyRequest,
      action: string,
      opts?: { entityType?: string; entityId?: string; meta?: Record<string, unknown> },
    ) => Promise<void>;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default fp(async (app) => {
  app.decorate('audit', async (req, action, opts) => {
    try {
      await app.prisma.auditLog.create({
        data: {
          userId: req.user?.id ?? null,
          action,
          entityType: opts?.entityType,
          entityId: opts?.entityId,
          meta: opts?.meta as never,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    } catch (err) {
      req.log.warn({ err }, 'audit write failed');
    }
  });

  // Best-effort catch-all audit for mutating requests that didn't call app.audit()
  // themselves. Structured logs are kept short — payloads live in per-route audits.
  app.addHook('onResponse', async (req, reply) => {
    if (!MUTATING.has(req.method)) return;
    if (reply.statusCode >= 500) return;
    if (!req.url.startsWith('/api/')) return;
    // Skip auth login (already logs its own event) and health.
    if (req.url === '/api/auth/login' || req.url === '/api/auth/refresh') return;
    // If the route already wrote a specific audit event, skip the generic one.
    if ((req as unknown as { auditWritten?: boolean }).auditWritten) return;
    try {
      await app.prisma.auditLog.create({
        data: {
          userId: req.user?.id ?? null,
          action: `${req.method.toLowerCase()} ${req.url.split('?')[0]}`,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    } catch { /* swallow */ }
  });
});
