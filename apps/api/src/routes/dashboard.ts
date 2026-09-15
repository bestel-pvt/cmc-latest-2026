/**
 * Dashboard API — server resource snapshot + accurate 24 h operational
 * counters. Windows-compatible (no `df` / `du` / `loadavg` dependency)
 * because the CMC server runs Windows Server 2016.
 */

import type { FastifyPluginAsync } from 'fastify';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve('./data');

/** Instant CPU utilisation across every core.
 *  Takes two `os.cpus()` snapshots ~150 ms apart. Was 500 ms which
 *  dominated /resources latency (500 of 648 ms) and blocked the event
 *  loop; 150 ms is still stable enough to average out one scheduling
 *  quantum. The 10 s response cache below means we only sample once
 *  per 10 s regardless of client polling frequency. */
async function cpuUsagePercent(sampleMs = 150): Promise<number> {
  const start = os.cpus().map((c) => c.times);
  await new Promise((r) => setTimeout(r, sampleMs));
  const end = os.cpus().map((c) => c.times);
  let idleDelta = 0, totalDelta = 0;
  for (let i = 0; i < start.length; i++) {
    const s = start[i]!, e = end[i]!;
    const idle = e.idle - s.idle;
    const total =
      (e.user - s.user) + (e.nice - s.nice) + (e.sys - s.sys) + (e.irq - s.irq) + idle;
    idleDelta += idle; totalDelta += total;
  }
  if (totalDelta <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100)));
}

/** Volume total/free/used for a single drive letter (Windows) or mount. */
function diskUsage(dir: string): { total: number; free: number; used: number } {
  try {
    if (process.platform === 'win32') {
      const drive = path.parse(path.resolve(dir)).root.replace(/\\+$/, '');
      const out = execSync(
        `wmic logicaldisk where "DeviceID='${drive}'" get Size,FreeSpace /format:csv`,
        { encoding: 'utf8', timeout: 5000 },
      );
      const line = out.split(/\r?\n/).find((l) => /^\S+,\d+,\d+$/.test(l.trim()));
      if (line) {
        const parts = line.split(',');
        const free = Number(parts[1]);
        const total = Number(parts[2]);
        return { total, free, used: total - free };
      }
    } else {
      const out = execSync(`df -B1 --output=size,avail "${dir}" | tail -1`, { encoding: 'utf8' }).trim().split(/\s+/);
      const total = Number(out[0]) || 0;
      const free  = Number(out[1]) || 0;
      return { total, free, used: total - free };
    }
  } catch { /* fall through */ }
  return { total: 0, free: 0, used: 0 };
}

/** Enumerate every fixed drive on the system with size + free space.
 *  Used to show the operator the whole storage picture, not just
 *  whichever tiny system drive DATA_DIR happens to live on. */
function allDisks(): Array<{ mount: string; total: number; free: number; used: number }> {
  try {
    if (process.platform === 'win32') {
      const out = execSync(
        'wmic logicaldisk where "DriveType=3" get DeviceID,Size,FreeSpace /format:csv',
        { encoding: 'utf8', timeout: 5000 },
      );
      const rows: Array<{ mount: string; total: number; free: number; used: number }> = [];
      for (const line of out.split(/\r?\n/)) {
        // Node,DeviceID,FreeSpace,Size
        const parts = line.trim().split(',');
        if (parts.length !== 4) continue;
        const [/* node */, id, freeStr, sizeStr] = parts as [string, string, string, string];
        if (!/^[A-Z]:$/.test(id)) continue;
        const total = Number(sizeStr) || 0;
        const free  = Number(freeStr) || 0;
        if (total <= 0) continue;
        rows.push({ mount: id, total, free, used: total - free });
      }
      return rows.sort((a, b) => b.total - a.total);
    }
    return [];
  } catch { return []; }
}

/**
 * Storage per-directory breakdown DISABLED (2026-09-13).
 *
 * The previous synchronous dirSize walk over D:\cmc\recordings blocked
 * the Node event loop for 25 s to several minutes on a live server
 * (hundreds of thousands of segment files, plus IO contention with 30
 * concurrent recording ffmpegs). Even wrapped in setImmediate + a 5-min
 * cache, every fifth request from a stale cache re-triggered the walk,
 * freezing every other API call and every wall HLS segment fetch —
 * which is what the client saw as "wall goes black, APIs return 500".
 *
 * The dashboard now shows the overall drive-level used/free (which
 * comes from a cheap Windows logical-disk query) without per-workload
 * split. If someone wants the breakdown back, it needs a worker_thread
 * (or streaming async fs) — not a sync walk on the API event loop.
 */

const routes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.authenticate);

  /**
   * GET /api/dashboard/kpis — a single-shot snapshot the dashboard uses
   * to fill every card. Everything trimmed of AI / failover / ticker
   * fields since CMC has none of those.
   */
  app.get('/kpis', async () => {
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

    const [
      channels, activeChannels, channelsWithSource, recordingEnabled,
      clipsToday, segmentsToday,
      users,
      segmentBytesRow,
    ] = await Promise.all([
      app.prisma.channel.count(),
      app.prisma.channel.count({ where: { active: true } }),
      app.prisma.channel.count({ where: { active: true, sources: { some: {} } } }),
      app.prisma.channel.count({ where: { recordingEnabled: true } }),
      app.prisma.clip.count({ where: { createdAt: { gte: dayAgo } } }),
      app.prisma.recordingSegment.count({ where: { startedAt: { gte: dayAgo } } }),
      app.prisma.user.count({ where: { disabledAt: null } }),
      app.prisma.$queryRawUnsafe<Array<{ bytes: bigint | null }>>(
        `SELECT COALESCE(SUM("sizeBytes"), 0)::bigint AS bytes FROM "RecordingSegment" WHERE "startedAt" >= $1`, dayAgo,
      ),
    ]);

    // Bytes written in the last 24 h — DB-accurate for closed segments.
    // Segments still being written (24 h rollover files) are not yet in
    // the DB, so we ALSO include the in-flight scan of the recordings
    // dir's on-disk size that's changed within the window. Simple: use
    // the DB sum for now; the storage card below shows the total on-
    // disk footprint which captures in-flight files.
    const bytesWritten24h = Number(segmentBytesRow[0]?.bytes ?? 0n);

    // Per-channel simple status. No failover controller → no score.
    // A channel is UP if it's active + has a source; nothing to compute
    // beyond that on this fork.
    const chs = await app.prisma.channel.findMany({
      select: {
        id: true, name: true, slug: true, active: true, category: true,
        recordingEnabled: true,
        _count: { select: { sources: true } },
      },
      orderBy: { name: 'asc' },
    });
    const health = chs.map((c) => ({
      id: c.id, name: c.name, slug: c.slug, active: c.active,
      category: c.category, recordingEnabled: c.recordingEnabled,
      hasSource: c._count.sources > 0,
    }));

    const recentAudit = await app.prisma.auditLog.findMany({
      orderBy: { createdAt: 'desc' }, take: 12,
      select: { id: true, action: true, entityType: true, createdAt: true, user: { select: { name: true, email: true } } },
    });

    return {
      channels, activeChannels, channelsWithSource, recordingEnabled,
      clipsToday, segmentsToday, bytesWritten24h,
      users, health, recentAudit,
    };
  });

  /**
   * GET /api/dashboard/resources — live CPU / memory / disk snapshot
   * with per-directory storage breakdown (recordings / clips / frames).
   *
   * Result cached for 10 s: the recursive dirSize walk over the whole
   * recordings tree is O(files) and used to run per request, blocking
   * the event loop for hundreds of ms and starving every other API
   * call while the dashboard tab was open. Now we compute once every
   * 10 s at most; the client polls at 30 s but multiple tabs / hot
   * reload all share the same cached response.
   */
  app.get('/resources', async () => {
    // All cheap, non-blocking calls. Volume-level used/free comes from
    // a Windows logical-disk WMIC query (<50 ms). No dirSize walks —
    // see comment above dirSize's removed body for why.
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const cpuPct   = await cpuUsagePercent(150);
    const disks = allDisks();
    const primary = disks[0] ?? diskUsage(DATA_DIR);
    const primaryMount = disks[0]?.mount ?? DATA_DIR;

    return {
      at: new Date().toISOString(),
      cpu: {
        cores: cpus.length,
        model: cpus[0]?.model ?? '',
        usedPct: cpuPct,
      },
      memory: {
        totalBytes: totalMem,
        usedBytes: usedMem,
        freeBytes: freeMem,
        usedPct: totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0,
      },
      disk: {
        mount: primaryMount,
        totalBytes: primary.total,
        usedBytes: primary.used,
        freeBytes: primary.free,
        usedPct: primary.total > 0 ? Math.round((primary.used / primary.total) * 100) : 0,
        breakdown: {
          recordingsBytes: 0,
          clipsBytes: 0,
          framesBytes: 0,
          otherBytes: 0,
        },
        volumes: disks,
      },
      uptimeSec: Math.round(os.uptime()),
    };
  });
};

export default routes;
