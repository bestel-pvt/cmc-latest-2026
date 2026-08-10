/**
 * CMC janitor.
 *
 *  1. Deletes recording segments older than RETENTION_DAYS (default 30).
 *  2. Deletes clip files older than CLIP_RETENTION_DAYS (default 30).
 *  3. Enforces a hard total-size QUOTA on the recordings tree — when total
 *     size crosses `quota × QUOTA_HIGH_WATERMARK` it deletes the OLDEST
 *     segments until it's back under `quota × QUOTA_LOW_WATERMARK`. This
 *     is the "storage-full safety net": if one channel's bitrate is higher
 *     than budgeted or the operator turns on more channels than planned,
 *     the disk never fills; the ring buffer just shortens.
 *  4. Skips any segment that overlaps an active LegalHold window
 *     (channel-scoped or global). Holds win over both age AND quota.
 *  5. `--dry-run` prints what it would delete without touching anything.
 *
 * Storage math (for RECORDING_TARGET_DAYS=30, 32 channels, 24h/day):
 *   avg 2 Mbps per channel × 32 ch × 86400 s × 30 d ÷ 8 ≈ 20.7 TB
 *   With headroom for bursty HD sources (4-6 Mbps): budget ~50 TB.
 *   Set RECORDINGS_QUOTA_GB accordingly to fit the physical drive.
 */

import { unlink } from 'node:fs/promises';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { prisma } from '@cmc/db';

const log = pino({ transport: process.env.NODE_ENV === 'production' ? undefined : { target: 'pino-pretty' } });

const RETENTION_DAYS      = Number(process.env.RETENTION_DAYS ?? 30);
const CLIP_RETENTION_DAYS = Number(process.env.CLIP_RETENTION_DAYS ?? 30);
const RECORDINGS_DIR      = resolve(process.env.RECORDINGS_DIR ?? './data/recordings');
const CLIPS_DIR           = resolve(process.env.CLIPS_DIR ?? './data/clips');
// Quota is expressed in GB so ops can set it from `df` output without
// unit gymnastics. Default 50 TB matches Task #206's storage plan.
const QUOTA_GB            = Number(process.env.RECORDINGS_QUOTA_GB ?? 50000);
const HIGH_WATERMARK      = Number(process.env.RECORDINGS_QUOTA_HIGH ?? 0.95); // start trimming
const LOW_WATERMARK       = Number(process.env.RECORDINGS_QUOTA_LOW  ?? 0.90); // stop trimming
const DRY_RUN             = process.argv.includes('--dry-run');

async function loadActiveHolds() {
  const now = new Date();
  return prisma.legalHold.findMany({
    where: { active: true, startsAt: { lte: now } },
  });
}

function isProtected(
  seg: { channelId: string; startedAt: Date; durationMs: number },
  holds: Awaited<ReturnType<typeof loadActiveHolds>>,
) {
  const segEnd = new Date(seg.startedAt.getTime() + seg.durationMs);
  for (const h of holds) {
    if (h.channelId && h.channelId !== seg.channelId) continue;
    if (h.startsAt < segEnd && h.endsAt > seg.startedAt) return true;
  }
  return false;
}

/** Total size of the recordings tree on disk (walks year/month/day/hour). */
function measureRecordingsBytes(): bigint {
  if (!existsSync(RECORDINGS_DIR)) return 0n;
  let total = 0n;
  function walk(dir: string) {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try { total += BigInt(statSync(p).size); } catch { /* */ }
      }
    }
  }
  walk(RECORDINGS_DIR);
  return total;
}

/** Age-based sweep: delete segments older than RETENTION_DAYS. */
async function sweepByAge(holds: Awaited<ReturnType<typeof loadActiveHolds>>) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 3600 * 1000);
  const stale = await prisma.recordingSegment.findMany({
    where: { startedAt: { lt: cutoff } },
    take: 5000,
    orderBy: { startedAt: 'asc' },
  });

  let deletedCount = 0, deletedBytes = 0n, protectedCount = 0;
  for (const seg of stale) {
    if (isProtected(seg, holds)) { protectedCount++; continue; }
    if (DRY_RUN) { deletedCount++; deletedBytes += seg.sizeBytes; continue; }
    try {
      await unlink(seg.path).catch(() => {});
      await unlink(seg.path + '.recorded').catch(() => {});
      await prisma.recordingSegment.delete({ where: { id: seg.id } });
      deletedCount++;
      deletedBytes += seg.sizeBytes;
    } catch (err) {
      log.warn({ err, id: seg.id }, 'failed to delete segment');
    }
  }
  log.info({ deletedCount, deletedGB: Number(deletedBytes) / 1e9, protectedCount, dryRun: DRY_RUN }, 'age sweep');
}

/** Quota sweep: if the recordings tree > quota × HIGH, delete oldest
 *  until it's under quota × LOW. Legal holds still win. */
async function sweepByQuota(holds: Awaited<ReturnType<typeof loadActiveHolds>>) {
  const quotaBytes = BigInt(Math.floor(QUOTA_GB * 1e9));
  const highBytes  = BigInt(Math.floor(QUOTA_GB * 1e9 * HIGH_WATERMARK));
  const lowBytes   = BigInt(Math.floor(QUOTA_GB * 1e9 * LOW_WATERMARK));
  const currentBytes = measureRecordingsBytes();
  const pct = Number(currentBytes) / Number(quotaBytes) * 100;
  log.info({ currentGB: (Number(currentBytes) / 1e9).toFixed(2), quotaGB: QUOTA_GB, pct: pct.toFixed(1) }, 'quota check');

  if (currentBytes < highBytes) return;

  log.warn({ pctFull: pct.toFixed(1) }, 'quota HIGH watermark hit — trimming oldest segments');

  // Iterate oldest-first in pages of 500 until we've freed enough.
  let freed = 0n;
  let deleted = 0, skippedHold = 0;
  const targetToFree = currentBytes - lowBytes;

  const pageSize = 500;
  let cursor: Date | null = null;
  type Seg = Awaited<ReturnType<typeof prisma.recordingSegment.findMany>>[number];
  while (freed < targetToFree) {
    const page: Seg[] = await prisma.recordingSegment.findMany({
      where: cursor ? { startedAt: { gt: cursor } } : {},
      orderBy: { startedAt: 'asc' },
      take: pageSize,
    });
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.startedAt;
    for (const seg of page) {
      if (freed >= targetToFree) break;
      if (isProtected(seg, holds)) { skippedHold++; continue; }
      if (DRY_RUN) { freed += seg.sizeBytes; deleted++; continue; }
      try {
        await unlink(seg.path).catch(() => {});
        await unlink(seg.path + '.recorded').catch(() => {});
        await prisma.recordingSegment.delete({ where: { id: seg.id } });
        freed += seg.sizeBytes;
        deleted++;
      } catch (err) {
        log.warn({ err, id: seg.id }, 'quota delete failed');
      }
    }
  }
  log.info({ deleted, freedGB: (Number(freed) / 1e9).toFixed(2), skippedHold, dryRun: DRY_RUN }, 'quota sweep complete');
}

/** Delete clip files + rows older than CLIP_RETENTION_DAYS. */
async function sweepClips() {
  const cutoff = new Date(Date.now() - CLIP_RETENTION_DAYS * 24 * 3600 * 1000);
  const stale = await prisma.clip.findMany({
    where: { createdAt: { lt: cutoff } },
    select: { id: true, path: true, sizeBytes: true },
    take: 5000,
    orderBy: { createdAt: 'asc' },
  });
  let deleted = 0, bytes = 0n;
  for (const c of stale) {
    if (DRY_RUN) { deleted++; bytes += c.sizeBytes ?? 0n; continue; }
    try {
      if (c.path) await unlink(c.path).catch(() => {});
      await prisma.clip.delete({ where: { id: c.id } });
      deleted++;
      bytes += c.sizeBytes ?? 0n;
    } catch (err) {
      log.warn({ err, id: c.id }, 'clip delete failed');
    }
  }
  log.info({ deleted, freedGB: (Number(bytes) / 1e9).toFixed(2), dryRun: DRY_RUN }, 'clip sweep');
  void CLIPS_DIR;
}

async function runOnce() {
  const holds = await loadActiveHolds();
  log.info({ retentionDays: RETENTION_DAYS, quotaGB: QUOTA_GB, holds: holds.length, dryRun: DRY_RUN }, 'janitor pass');
  await sweepByAge(holds);
  await sweepClips();
  await sweepByQuota(holds);
}

async function main() {
  await runOnce();
  // On the server run every 10 min (age sweep is cheap, quota check is
  // one recursive walk of RECORDINGS_DIR — a few seconds for 50 TB).
  // Old default was 60 min which meant a runaway high-bitrate channel
  // could fill an extra 30 GB before the next check.
  if (process.argv.includes('--loop')) {
    setInterval(runOnce, 10 * 60 * 1000);
  } else {
    process.exit(0);
  }
}

main().catch((err) => { log.error(err); process.exit(1); });
