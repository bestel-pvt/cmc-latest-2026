/**
 * DEMP janitor.
 *  - Runs every hour.
 *  - Deletes recording segments older than RETENTION_DAYS.
 *  - Skips any segment that overlaps an active LegalHold window
 *    (channel-scoped or global).
 *  - `--dry-run` prints what it would delete without touching anything.
 */

import { unlink } from 'node:fs/promises';
import pino from 'pino';
import { prisma } from '@cmc/db';

const log = pino({ transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' } });

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 30);
const DRY_RUN = process.argv.includes('--dry-run');

async function loadActiveHolds() {
  const now = new Date();
  return prisma.legalHold.findMany({
    where: { active: true, startsAt: { lte: now } /* endsAt in the future OR overlaps */ },
  });
}

function isProtected(seg: { channelId: string; startedAt: Date; durationMs: number }, holds: Awaited<ReturnType<typeof loadActiveHolds>>) {
  const segEnd = new Date(seg.startedAt.getTime() + seg.durationMs);
  for (const h of holds) {
    if (h.channelId && h.channelId !== seg.channelId) continue; // channel-scoped hold doesn't match
    // overlap: hold.startsAt < segEnd && hold.endsAt > seg.startedAt
    if (h.startsAt < segEnd && h.endsAt > seg.startedAt) return true;
  }
  return false;
}

async function runOnce() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
  const holds = await loadActiveHolds();
  log.info({ cutoff: cutoff.toISOString(), holds: holds.length, dryRun: DRY_RUN }, 'janitor sweep');

  const stale = await prisma.recordingSegment.findMany({
    where: { startedAt: { lt: cutoff } },
    take: 5000, // batch
    orderBy: { startedAt: 'asc' },
  });

  let deletedCount = 0, deletedBytes = 0n, protectedCount = 0;
  for (const seg of stale) {
    if (isProtected(seg, holds)) { protectedCount++; continue; }
    if (DRY_RUN) { deletedCount++; deletedBytes += seg.sizeBytes; continue; }
    try {
      await unlink(seg.path).catch(() => {});
      await prisma.recordingSegment.delete({ where: { id: seg.id } });
      deletedCount++;
      deletedBytes += seg.sizeBytes;
    } catch (err) {
      log.warn({ err, id: seg.id }, 'failed to delete segment');
    }
  }
  log.info({ deletedCount, deletedGB: Number(deletedBytes) / 1e9, protectedCount, dryRun: DRY_RUN }, 'janitor sweep complete');
}

async function main() {
  await runOnce();
  // On-server: run every hour. In dev, exit after one pass unless --loop.
  if (process.argv.includes('--loop')) {
    setInterval(runOnce, 60 * 60 * 1000);
  } else {
    process.exit(0);
  }
}

main().catch((err) => { log.error(err); process.exit(1); });
