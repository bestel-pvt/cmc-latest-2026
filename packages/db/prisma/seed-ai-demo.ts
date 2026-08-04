/* eslint-disable no-console */
/**
 * Populates the DB with realistic-looking Ticker + Flasher events, semantic
 * groups, AI jobs, and AIFeedback so operators can see the /tickers,
 * /flashers, and /admin/ai-health pages come alive without needing FFmpeg
 * or real streams.
 *
 * Idempotent: purges any prior demo rows (tagged with a `demo:` prefix on
 * their id) before re-populating.
 *
 * Run:  pnpm db:seed:demo
 */
import { PrismaClient, TickerKind, AIJobKind, AIJobStatus, AIJobPriority } from '@prisma/client';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const prisma = new PrismaClient();

// ---------- placeholder image ----------
// Absolute minimum: a 1×1 transparent PNG we point every event's imagePath at.
const PNG_1x1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const DATA_DIR       = resolve(process.cwd(), '../../data');
const TICKERS_DIR    = resolve(DATA_DIR, 'tickers');
const PLACEHOLDER    = resolve(DATA_DIR, 'demo-placeholder.png');

// ---------- demo copy pools ----------
type Line = { text: string; language: string };

// Ticker (bottom scroller) headlines — pool of ~10, some overlap in meaning
// across languages so the semantic grouper has something to cluster.
const TICKERS: Line[] = [
  { text: 'PM addresses the nation on economic reforms and IMF loan tranche',        language: 'en' },
  { text: 'وزیراعظم کا معاشی اصلاحات اور آئی ایم ایف قسط پر قوم سے خطاب',              language: 'ur' },
  { text: 'Karachi weather: heavy rain expected in city over next 48 hours',           language: 'en' },
  { text: 'کراچی میں آئندہ 48 گھنٹوں کے دوران شدید بارش کی پیش گوئی',                    language: 'ur' },
  { text: 'PSX benchmark index closes 480 points higher on foreign inflows',           language: 'en' },
  { text: 'Pakistan cricket team announces squad for Champions Trophy series',         language: 'en' },
  { text: 'پاکستانی کرکٹ ٹیم کا چیمپیئنز ٹرافی کے لیے اسکواڈ کا اعلان',                  language: 'ur' },
  { text: 'FBR extends tax return filing deadline for salaried individuals',           language: 'en' },
  { text: 'وفاقی حکومت نے تنخواہ دار طبقے کے لیے گوشوارے جمع کروانے کی تاریخ بڑھا دی',   language: 'ur' },
  { text: 'Petrol price to be revised at midnight, decrease of Rs 4 expected',         language: 'en' },
];

// Flasher (mid-screen breaking box) copy — shorter, urgent phrasing
const FLASHERS: Line[] = [
  { text: 'BREAKING: Blast reported near Peshawar police station', language: 'en' },
  { text: 'اہم خبر: پشاور تھانے کے قریب دھماکہ',                    language: 'ur' },
  { text: 'ALERT: Islamabad High Court reserves verdict in petition', language: 'en' },
  { text: 'BREAKING: PSL final match to start at 8pm sharp', language: 'en' },
  { text: 'اہم اعلان: پی ایس ایل کا فائنل رات آٹھ بجے شروع ہوگا',      language: 'ur' },
  { text: 'BREAKING: Fresh negotiations announced between government and opposition', language: 'en' },
];

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim();
}

// Given a list of {text, language} pool items, form semantic groups by
// normalized-prefix overlap (proxy for what the real sentence-transformer does).
function groupKey(l: Line): string {
  const words = norm(l.text).split(' ').slice(0, 3).join(' ');
  return words;
}

function jitterSeconds(range: number) {
  return Math.floor(Math.random() * range);
}

async function purgeDemo() {
  // Everything demo-seeded gets a "demo_" id prefix so we can wipe cleanly.
  await prisma.aIFeedback.deleteMany({ where: { id: { startsWith: 'demo_' } } });
  await prisma.aIJob.deleteMany({ where: { id: { startsWith: 'demo_' } } });
  await prisma.tickerEvent.deleteMany({ where: { id: { startsWith: 'demo_' } } });
  await prisma.tickerGroup.deleteMany({ where: { id: { startsWith: 'demo_' } } });
}

async function seed() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(PLACEHOLDER)) writeFileSync(PLACEHOLDER, PNG_1x1);

  const channels = await prisma.channel.findMany({ where: { active: true }, take: 5 });
  if (channels.length === 0) throw new Error('No channels seeded — run `pnpm db:seed` first.');
  console.log(`seeding demo AI data across ${channels.length} channels`);

  await purgeDemo();

  const now = Date.now();
  const LOOKBACK_MS = 6 * 3600 * 1000;

  // Groups first — one per pool line, keyed by (kind, groupKey(line)).
  const groupIdMap = new Map<string, string>(); // `${kind}|${key}` -> gid
  let groupSeq = 0;

  function ensureGroupId(kind: TickerKind, line: Line): string {
    const key = `${kind}|${groupKey(line)}`;
    let id = groupIdMap.get(key);
    if (id) return id;
    id = `demo_g_${(++groupSeq).toString().padStart(4, '0')}`;
    groupIdMap.set(key, id);
    return id;
  }

  // Emit ticker events
  const tickerEventCreates: unknown[] = [];
  const flasherEventCreates: unknown[] = [];
  const feedbackCreates: unknown[] = [];
  const groupStats = new Map<string, {
    kind: TickerKind; text: string; language: string;
    channels: Set<string>; count: number; first: Date; last: Date;
  }>();

  let evtSeq = 0;
  function pushEvent(kind: TickerKind, channelId: string, channelSlug: string, line: Line, startedAt: Date, endedAt: Date) {
    const eid = `demo_e_${(++evtSeq).toString().padStart(6, '0')}`;
    const gid = ensureGroupId(kind, line);
    const conf = 0.62 + Math.random() * 0.34;
    const durMs = Math.max(1500, endedAt.getTime() - startedAt.getTime());
    const rect = kind === 'TICKER'
      ? { x: 0.0, y: 0.86, w: 1.0, h: 0.10 }
      : kind === 'FLASHER_LEFT'
        ? { x: 0.02, y: 0.28, w: 0.24, h: 0.36 }
        : { x: 0.74, y: 0.28, w: 0.24, h: 0.36 };

    (kind === 'TICKER' ? tickerEventCreates : flasherEventCreates).push({
      id: eid,
      channelId,
      kind,
      startedAt, endedAt, durationMs: durMs,
      text: line.text,
      textNormalized: norm(line.text),
      language: line.language,
      confidence: conf,
      cropRect: rect,
      imagePath: PLACEHOLDER,
      tickerGroupId: gid,
    });
    feedbackCreates.push({
      id: `demo_f_${eid.slice(-8)}`,
      kind: AIJobKind.OCR_TICKER,
      channelId,
      targetType: 'TickerEvent',
      targetId: eid,
      ranAt: endedAt,
      success: conf > 0.55,
      confidence: conf,
    });

    const g = groupStats.get(gid) ?? {
      kind, text: line.text, language: line.language,
      channels: new Set<string>(), count: 0, first: startedAt, last: endedAt,
    };
    g.channels.add(channelSlug); g.count += 1;
    if (startedAt < g.first) g.first = startedAt;
    if (endedAt   > g.last)  g.last  = endedAt;
    groupStats.set(gid, g);
  }

  for (const ch of channels) {
    // 12 ticker events over the last 6h, ~5-40s each
    for (let i = 0; i < 12; i++) {
      const start = new Date(now - (LOOKBACK_MS - i * (LOOKBACK_MS / 12)) + jitterSeconds(300) * 1000);
      const end   = new Date(start.getTime() + 5000 + jitterSeconds(35) * 1000);
      const line  = TICKERS[Math.floor(Math.random() * TICKERS.length)]!;
      pushEvent('TICKER', ch.id, ch.slug, line, start, end);
    }
    // 6 flasher events over the last 4h, ~4-15s each — mix LEFT / RIGHT
    for (let i = 0; i < 6; i++) {
      const start = new Date(now - (4 * 3600 * 1000 - i * (4 * 3600 * 1000 / 6)) + jitterSeconds(300) * 1000);
      const end   = new Date(start.getTime() + 4000 + jitterSeconds(11) * 1000);
      const line  = FLASHERS[Math.floor(Math.random() * FLASHERS.length)]!;
      const kind: TickerKind = Math.random() > 0.5 ? 'FLASHER_LEFT' : 'FLASHER_RIGHT';
      pushEvent(kind, ch.id, ch.slug, line, start, end);
    }
  }

  // Insert groups first
  for (const [gid, g] of groupStats) {
    await prisma.tickerGroup.upsert({
      where: { id: gid },
      update: {
        canonicalText: g.text,
        language: g.language,
        firstSeenAt: g.first,
        lastSeenAt:  g.last,
        occurrenceCount: g.count,
        channelCount: g.channels.size,
        channels: Array.from(g.channels),
      },
      create: {
        id: gid,
        kind: g.kind,
        canonicalText: g.text,
        language: g.language,
        firstSeenAt: g.first,
        lastSeenAt:  g.last,
        occurrenceCount: g.count,
        channelCount: g.channels.size,
        channels: Array.from(g.channels),
      },
    });
  }
  console.log(`groups: ${groupStats.size}`);

  // Then events + feedback
  await prisma.tickerEvent.createMany({ data: tickerEventCreates as never, skipDuplicates: true });
  await prisma.tickerEvent.createMany({ data: flasherEventCreates as never, skipDuplicates: true });
  await prisma.aIFeedback.createMany({ data: feedbackCreates as never, skipDuplicates: true });
  console.log(`ticker events: ${tickerEventCreates.length}, flasher events: ${flasherEventCreates.length}, feedback rows: ${feedbackCreates.length}`);

  // ------------ demo AI jobs (transcription-shaped) ------------
  // Insert 5 completed transcribe jobs + 1 running + 1 queued so /admin/ai-health
  // and the recordings Transcribe button feel alive.
  const seg = await prisma.recordingSegment.findFirst();
  if (seg) {
    const kinds: Array<{ status: AIJobStatus; progress: number; message?: string; error?: string }> = [
      { status: 'DONE',    progress: 100, message: 'lang=ur words=142' },
      { status: 'DONE',    progress: 100, message: 'lang=en words=98' },
      { status: 'DONE',    progress: 100, message: 'lang=ur words=203' },
      { status: 'DONE',    progress: 100, message: 'lang=en words=61' },
      { status: 'FAILED',  progress: 0,   error: 'audio silence rate > 80%' },
      { status: 'RUNNING', progress: 42,  message: 'processing chunk 3/7' },
      { status: 'QUEUED',  progress: 0 },
    ];
    for (let i = 0; i < kinds.length; i++) {
      const k = kinds[i]!;
      const finished = k.status === 'DONE' || k.status === 'FAILED'
        ? new Date(now - i * 5 * 60 * 1000) : null;
      const started = (k.status === 'RUNNING' || finished)
        ? new Date(now - (i * 5 + 1) * 60 * 1000) : null;
      await prisma.aIJob.create({
        data: {
          id: `demo_j_${(i + 1).toString().padStart(3, '0')}`,
          kind: AIJobKind.TRANSCRIBE_SEGMENT,
          targetType: 'RecordingSegment',
          targetId: seg.id,
          channelId: seg.channelId,
          priority: AIJobPriority.NORMAL,
          status: k.status,
          progress: k.progress,
          message: k.message ?? null,
          error: k.error ?? null,
          startedAt: started,
          finishedAt: finished,
        },
      });
      if (k.status === 'DONE' || k.status === 'FAILED') {
        await prisma.aIFeedback.create({
          data: {
            id: `demo_jf_${(i + 1).toString().padStart(3, '0')}`,
            kind: AIJobKind.TRANSCRIBE_SEGMENT,
            channelId: seg.channelId,
            targetType: 'RecordingSegment',
            targetId: seg.id,
            success: k.status === 'DONE',
            confidence: k.status === 'DONE' ? 0.78 : 0.20,
            errorPct: k.status === 'FAILED' ? 100 : null,
            message: k.status === 'FAILED' ? k.error ?? null : null,
          },
        });
      }
    }
    console.log(`ai jobs: ${kinds.length}`);
  } else {
    console.log('(no recording segments seeded yet — skipping AIJob demo rows; run the recording service to create some)');
  }

  console.log('done.');
}

seed()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
