import fp from 'fastify-plugin';
import type { WebSocket } from '@fastify/websocket';

// Redis pub/sub channel names emitted by the failover controller, recording
// service, transcription worker, ticker-detect worker.
const REDIS_CHANNELS = [
  'demp:events:channel-health',
  'demp:events:source-switch',
  'demp:events:segment',
  'demp:events:transcript',
  'demp:events:alert',
];

interface HubClient {
  socket: WebSocket;
  subscriptions: Set<string>; // channelId subscriptions
  all: boolean;               // subscribed to global stream
}

declare module 'fastify' {
  interface FastifyInstance {
    hub: {
      broadcast: (channelId: string | null, payload: unknown) => void;
    };
  }
}

export default fp(async (app) => {
  const clients = new Set<HubClient>();

  // ---- Redis subscribe → fan out to browsers ----
  for (const ch of REDIS_CHANNELS) await app.redisSub.subscribe(ch);
  app.redisSub.on('message', (_ch, raw) => {
    let msg: { channelId?: string } & Record<string, unknown>;
    try { msg = JSON.parse(raw); } catch { return; }
    const channelId = msg.channelId ?? null;
    for (const c of clients) {
      if (c.socket.readyState !== 1) continue;
      if (c.all || (channelId && c.subscriptions.has(channelId))) {
        try { c.socket.send(raw); } catch { /* ignore */ }
      }
    }
  });

  app.decorate('hub', {
    broadcast(channelId, payload) {
      const raw = JSON.stringify(payload);
      for (const c of clients) {
        if (c.socket.readyState !== 1) continue;
        if (c.all || (channelId && c.subscriptions.has(channelId))) {
          try { c.socket.send(raw); } catch { /* ignore */ }
        }
      }
    },
  });

  // ---- WebSocket endpoint ----
  app.get('/ws', { websocket: true }, (socket, req) => {
    const client: HubClient = { socket, subscriptions: new Set(), all: false };
    clients.add(client);
    req.log.info({ ip: req.ip }, 'ws client connected');

    socket.on('message', (buf: Buffer) => {
      let m: { type?: string; channelId?: string };
      try { m = JSON.parse(buf.toString()); } catch { return; }
      if (m.type === 'sub' && m.channelId) client.subscriptions.add(m.channelId);
      if (m.type === 'unsub' && m.channelId) client.subscriptions.delete(m.channelId);
      if (m.type === 'sub-all') client.all = true;
      if (m.type === 'unsub-all') client.all = false;
      if (m.type === 'ping') socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    });
    socket.on('close', () => { clients.delete(client); });
    socket.on('error', () => { clients.delete(client); });
  });
});
