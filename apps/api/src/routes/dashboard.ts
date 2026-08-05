import type { FastifyPluginAsync } from 'fastify';
import os from 'node:os';
import { statSync } from 'node:fs';
import { execSync } from 'node:child_process';

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * Real-time server resource snapshot for the dashboard's "System" card.
   * CPU load-avg / free memory / disk usage of the DATA_DIR volume /
   * process uptime — all read straight from `/proc` and `df` so there is
   * zero dependency on containers.
   */
  app.get('/system', async () => {
    const cpus = os.cpus();
    const [load1, load5, load15] = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    // Disk stats via `df -B1 <dir>` (bytes). Cheap; ~5ms.
    const dataDir = process.env.DATA_DIR ?? '/data/demp';
    let disk = { total: 0, used: 0, available: 0, mount: dataDir };
    try {
      const out = execSync(`df -B1 --output=size,used,avail,target "${dataDir}" 2>/dev/null | tail -1`, { encoding: 'utf8' }).trim().split(/\s+/);
      if (out.length >= 4) {
        disk = { total: Number(out[0]) || 0, used: Number(out[1]) || 0, available: Number(out[2]) || 0, mount: out[3] ?? dataDir };
      }
    } catch { /* df not available (Windows dev) — leave zeros */ }

    // Recording data footprint (subset of the disk usage above)
    let recordingsBytes = 0;
    try {
      recordingsBytes = statSync(`${dataDir}/recordings`, { throwIfNoEntry: false })?.size ?? 0;
      // For a real number use du; keep this cheap. Real total lives in RecordingSegment aggregates.
      recordingsBytes = Number(execSync(`du -sb "${dataDir}/recordings" 2>/dev/null | awk '{print $1}'`, { encoding: 'utf8' }).trim()) || 0;
    } catch { /* */ }

    return {
      at: new Date().toISOString(),
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model ?? '',
        loadAvg: { m1: load1 ?? 0, m5: load5 ?? 0, m15: load15 ?? 0 },
        loadPct1m: cpus.length ? Math.min(100, Math.round(((load1 ?? 0) / cpus.length) * 100)) : 0,
      },
      memory: {
        totalBytes: totalMem, freeBytes: freeMem, usedBytes: usedMem,
        usedPct: Math.round((usedMem / totalMem) * 100),
      },
      disk: {
        ...disk,
        usedPct: disk.total ? Math.round((disk.used / disk.total) * 100) : 0,
      },
      recordingsBytes,
      uptimeSec: Math.round(os.uptime()),
    };
  });

  app.get('/kpis', async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

    // Base counts (parallel)
    const [
      channels, sources, activeChannels, aiEnabled, channelsWithSource, clipsToday, segmentsToday,
      tickers24h, flashers24h, gptQueries24h, ocrRuns24h, users,
      segmentBytesRow,
    ] = await Promise.all([
      app.prisma.channel.count(),
      app.prisma.source.count(),
      app.prisma.channel.count({ where: { active: true } }),
      app.prisma.channel.count({ where: { aiFeaturesEnabled: true } }),
      app.prisma.channel.count({ where: { active: true, sources: { some: {} } } }),
      app.prisma.clip.count({ where: { createdAt: { gte: dayAgo } } }),
      app.prisma.recordingSegment.count({ where: { startedAt: { gte: dayAgo } } }),
      app.prisma.tickerEvent.count({ where: { kind: 'TICKER',        startedAt: { gte: dayAgo } } }),
      app.prisma.tickerEvent.count({ where: { kind: { in: ['FLASHER_LEFT', 'FLASHER_RIGHT'] }, startedAt: { gte: dayAgo } } }),
      app.prisma.message.count({ where: { role: 'USER', createdAt: { gte: dayAgo } } }),
      app.prisma.aIFeedback.count({ where: { kind: 'OCR_TICKER', ranAt: { gte: dayAgo } } }),
      app.prisma.user.count({ where: { disabledAt: null } }),
      app.prisma.$queryRawUnsafe<Array<{ bytes: bigint | null }>>(
        `SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS bytes FROM "RecordingSegment" WHERE "startedAt" >= $1`, dayAgo,
      ),
    ]);

    const bytesWritten24h = Number(segmentBytesRow[0]?.bytes ?? 0n);
    const onAirMinutes24h = Math.round(segmentsToday * 60 / 60);

    // Redis-backed per-channel health snapshot. The failover controller
    // (when running) writes a rolling score into Redis; when nothing is
    // scoring we simply return null and the UI falls back to
    // "trust operator config" — see dashboard/page.tsx for that rule.
    const chs = await app.prisma.channel.findMany({
      select: {
        id: true, name: true, slug: true, active: true,
        aiFeaturesEnabled: true, category: true,
        _count: { select: { sources: true } },
      },
      orderBy: { name: 'asc' },
    });

    const health = await Promise.all(chs.map(async (c) => {
      const s = await app.redis.hgetall(`demp:ch:${c.id}:state`);
      const redisScore = s.score !== undefined && s.score !== '' ? Number(s.score) : null;
      return {
        id: c.id, name: c.name, slug: c.slug, active: c.active,
        aiFeaturesEnabled: c.aiFeaturesEnabled, category: c.category,
        hasSource: c._count.sources > 0,
        score: redisScore,
        lastSwitchAt: s.lastSwitchAt ? Number(s.lastSwitchAt) : null,
        activeSourceId: s.activeSourceId ?? null,
      };
    }));

    // Recent activity — audit log only now (alerts retired)
    const recentAudit = await app.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' }, take: 12,
      select: { id: true, action: true, entityType: true, createdAt: true, user: { select: { name: true, email: true } } },
    });

    return {
      channels, sources, activeChannels, aiEnabled, channelsWithSource,
      clipsToday, segmentsToday,
      tickers24h, flashers24h, gptQueries24h, ocrRuns24h,
      users,
      bytesWritten24h, onAirMinutes24h,
      health, recentAudit,
    };
  });
};

export default routes;
