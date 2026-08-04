import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '../env.js';

declare module 'fastify' {
  interface FastifyInstance {
    redis: Redis;
    redisPub: Redis;
    redisSub: Redis;
  }
}

export default fp(async (app) => {
  const redis    = new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: null });
  const redisPub = new Redis(env.REDIS_URL);
  const redisSub = new Redis(env.REDIS_URL);

  redis.on('error',    (e) => app.log.error({ err: e }, 'redis error'));
  redisPub.on('error', (e) => app.log.error({ err: e }, 'redis pub error'));
  redisSub.on('error', (e) => app.log.error({ err: e }, 'redis sub error'));

  app.decorate('redis', redis);
  app.decorate('redisPub', redisPub);
  app.decorate('redisSub', redisSub);

  app.addHook('onClose', async () => {
    await Promise.allSettled([redis.quit(), redisPub.quit(), redisSub.quit()]);
  });
});
