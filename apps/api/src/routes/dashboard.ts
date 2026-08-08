/**
 * Dashboard API — server resource snapshot + accurate 24 h operational
 * counters. Windows-compatible (no `df` / `du` / `loadavg` dependency)
 * because the CMC server runs Windows Server 2016.
 */

import type { FastifyPluginAsync } from 'fastify';
import os from 'node:os';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const DATA_DIR       = process.env.DATA_DIR       ? path.resolve(process.env.DATA_DIR)       : path.resolve('./data');
// Per-workload paths. These may point to a different volume than
// DATA_DIR — recordings and clips typically live on the big storage
// drive (D:) while DATA_DIR is on C: for hls / frames / logos. The
// dashboard breakdown looks at each configured path individually.
const RECORDINGS_DIR = process.env.RECORDINGS_DIR ? path.resolve(process.env.RECORDINGS_DIR) : path.join(DATA_DIR, 'recordings');
const CLIPS_DIR      = process.env.CLIPS_DIR      ? path.resolve(process.env.CLIPS_DIR)      : path.join(DATA_DIR, 'clips');
const FRAMES_ROOT    = process.env.FRAMES_DIR     ? path.resolve(process.env.FRAMES_DIR)     : path.join(DATA_DIR, 'frames');

/** Instant CPU utilisation across every core.
 *  Takes two `os.cpus()` snapshots ~500 ms apart, computes the delta
 *  of busy-time vs total-time. Cross-platform, no `loadavg` (which is
 *  0 on Windows). Cost: 500 ms per call — dashboard refreshes every
 *  5-10 s so this is fine. */
async function cpuUsagePercent(sampleMs = 500): Promise<number> {
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

/** Recursive directory size in bytes. Skips symlinks. Silent on errors. */
function dirSize(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  const stack: string[] = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: import('node:fs').Dirent[] = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile()) {
        try { total += statSync(full).size; } catch { /* file vanished mid-scan */ }
      }
    }
  }
  return total;
}

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
   * Refreshed on demand — the dashboard polls this every 10 s.
   */
  app.get('/resources', async () => {
    // Directory sizes CAN be expensive on TB-scale data. Cap the scan
    // to top-level accounting only for now: sum files at top of each
    // dir plus one level deep. If perf becomes an issue, we can cache.
    // Currently:
    //   data/recordings/<channelId>/<yyyy>/<mm>/<dd>/<hh>/*.mp4
    //   data/clips/*.mp4|.mov|.mkv
    //   data/frames/<yyyy-mm-dd>/*.png
    // Per-workload sizes — from CONFIGURED paths, so recordings on
    // D:\cmc\recordings + clips on D:\cmc\clips are correctly summed.
    const recordingsBytes = dirSize(RECORDINGS_DIR);
    const clipsBytes      = dirSize(CLIPS_DIR);
    const framesBytes     = dirSize(FRAMES_ROOT);

    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const cpuPct   = await cpuUsagePercent(500);

    // Show ALL fixed drives, biggest first — the actual storage
    // hardware. The single "primary" (biggest, i.e. the recording
    // volume) still drives the top-line percentage/bar, but the
    // operator sees the full picture instead of thinking their tiny
    // system C: drive is all the storage they have.
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
        // Per-workload footprint — reads from CONFIGURED paths so
        // recordings sitting on D: are counted even though the
        // primary "used" is measured for the D: drive as a whole.
        breakdown: {
          recordingsBytes,
          clipsBytes,
          framesBytes,
          otherBytes: Math.max(0, primary.used - recordingsBytes - clipsBytes - framesBytes),
        },
        // Every drive so the operator sees the whole system.
        volumes: disks,
      },
      uptimeSec: Math.round(os.uptime()),
    };
  });
};

export default routes;
