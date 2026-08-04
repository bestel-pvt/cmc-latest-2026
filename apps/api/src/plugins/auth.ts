import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Role } from '@cmc/db';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authorize: (roles: Role[]) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: { id: string; email: string; role: Role };
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; email: string; role: Role };
    user: { id: string; email: string; role: Role };
  }
}

export default fp(async (app) => {
  app.decorate('authenticate', async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const payload = await req.jwtVerify<{ sub: string; email: string; role: Role }>();
      req.user = { id: payload.sub, email: payload.email, role: payload.role };
    } catch (err) {
      reply.code(401).send({ error: 'Unauthorized' });
    }
  });

  app.decorate('authorize', (roles: Role[]) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      reply.code(401).send({ error: 'Unauthorized' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      reply.code(403).send({ error: 'Forbidden' });
    }
  });
});
