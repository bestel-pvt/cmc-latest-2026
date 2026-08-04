/* eslint-disable no-console */
/**
 * Production channel seed — 111 UDP channels from the client's uplink sheet.
 * Runs idempotently: existing channels (matched by slug) get updated;
 * missing ones are created with a single "Satellite" source flagged as
 * primary + first-priority.
 *
 * AI features (recording, tickers, flashers, transcription, alerts) are
 * ENABLED only for ARY News and Dunya News per the current demo scope.
 * Failover + multiviewer + the DEMP UDP re-broadcast run for every channel.
 *
 * Run:  pnpm db:seed:prod
 */
import { PrismaClient, ChannelCategory, ChannelLanguage, SourceKind } from '@prisma/client';

const prisma = new PrismaClient();

// slug helper
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, '-')        // remove parenthetical annotations
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

// (name, port, category, language) — 111 rows from UDP (1).docx
type Row = { name: string; port: number; category: ChannelCategory; language: ChannelLanguage };

const CHANNELS: Row[] = [
  // ---- Pakistani news (Table 0)
  { name: 'PTV News',           port: 2012, category: 'NEWS',          language: 'UR' },
  { name: 'City 41',            port: 2004, category: 'REGIONAL',      language: 'UR' },
  { name: 'Dunya News',         port: 2020, category: 'NEWS',          language: 'UR' },
  { name: 'Samaa TV',           port: 2024, category: 'NEWS',          language: 'UR' },
  { name: 'Hum News HD',        port: 3030, category: 'NEWS',          language: 'UR' },
  { name: 'Express News',       port: 2026, category: 'NEWS',          language: 'UR' },
  { name: 'ARY News',           port: 3108, category: 'NEWS',          language: 'UR' },
  { name: 'Aik News',           port: 2034, category: 'NEWS',          language: 'UR' },
  { name: 'Dawn News',          port: 2036, category: 'NEWS',          language: 'EN' },
  { name: '24 News HD',         port: 2000, category: 'NEWS',          language: 'UR' },
  { name: 'Abb Takk',           port: 3126, category: 'NEWS',          language: 'UR' },
  { name: 'Aaj News',           port: 2042, category: 'NEWS',          language: 'UR' },
  { name: 'Bol News',           port: 3096, category: 'NEWS',          language: 'UR' },
  { name: '92 News HD',         port: 3014, category: 'NEWS',          language: 'UR' },
  { name: 'GNN',                port: 2046, category: 'NEWS',          language: 'UR' },
  { name: 'Public News',        port: 3054, category: 'NEWS',          language: 'UR' },
  { name: 'Capital TV',         port: 3068, category: 'NEWS',          language: 'UR' },
  { name: 'News One',           port: 3056, category: 'NEWS',          language: 'UR' },
  { name: 'Neo News HD',        port: 2050, category: 'NEWS',          language: 'UR' },
  { name: 'Suno News HD',       port: 2048, category: 'NEWS',          language: 'UR' },
  { name: '365 News',           port: 2038, category: 'NEWS',          language: 'UR' },
  { name: 'Discover Pakistan',  port: 3070, category: 'DOCUMENTARY',   language: 'UR' },
  { name: 'ABN News HD',        port: 2054, category: 'NEWS',          language: 'UR' },
  { name: 'GTV HD',             port: 2056, category: 'NEWS',          language: 'UR' },
  { name: 'Sindh News',         port: 2064, category: 'REGIONAL',      language: 'UR' },
  { name: 'KTN News',           port: 2082, category: 'REGIONAL',      language: 'UR' },
  { name: 'Khyber News',        port: 3186, category: 'REGIONAL',      language: 'UR' },
  { name: 'VSH',                port: 2066, category: 'REGIONAL',      language: 'UR' },
  { name: 'Mashriq TV',         port: 2044, category: 'REGIONAL',      language: 'UR' },
  { name: 'Times News',         port: 2088, category: 'NEWS',          language: 'UR' },
  { name: 'Mehran TV',          port: 2090, category: 'REGIONAL',      language: 'UR' },
  { name: 'Awaz TV',            port: 2092, category: 'REGIONAL',      language: 'UR' },
  { name: 'Waseeb TV',          port: 3058, category: 'REGIONAL',      language: 'UR' },
  { name: 'Rohi News',          port: 2006, category: 'REGIONAL',      language: 'UR' },
  { name: 'Dharti News',        port: 2094, category: 'REGIONAL',      language: 'UR' },
  { name: 'Hum Pashto 1',       port: 2060, category: 'REGIONAL',      language: 'PA' },
  { name: 'Kohenoor TV',        port: 2058, category: 'NEWS',          language: 'UR' },
  { name: 'City 42',            port: 2002, category: 'REGIONAL',      language: 'UR' },
  { name: 'Such TV',            port: 2096, category: 'NEWS',          language: 'UR' },
  { name: 'Roz News',           port: 2098, category: 'NEWS',          language: 'UR' },
  { name: 'Channel 5',          port: 3088, category: 'NEWS',          language: 'UR' },
  { name: 'Lahore News',        port: 2022, category: 'REGIONAL',      language: 'UR' },
  { name: 'K 2',                port: 3182, category: 'REGIONAL',      language: 'UR' },
  { name: 'Lahore Rang HD',     port: 2052, category: 'REGIONAL',      language: 'UR' },
  { name: 'K 21',               port: 3130, category: 'REGIONAL',      language: 'UR' },
  { name: 'Apna TV HD',         port: 3122, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'M News',             port: 3000, category: 'NEWS',          language: 'UR' },
  { name: 'NTN News',           port: 3132, category: 'NEWS',          language: 'UR' },
  { name: 'Pakistan TV',        port: 2014, category: 'NEWS',          language: 'UR' },
  { name: 'Ocean News',         port: 3188, category: 'NEWS',          language: 'UR' },
  { name: 'DM English HD',      port: 3190, category: 'NEWS',          language: 'EN' },

  // ---- Entertainment / Sports (Table 1)
  { name: 'ARY Digital Asia HD', port: 3102, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Green Entertainment', port: 3012, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Express Entertainment', port: 2028, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'AVT Khyber',         port: 3184, category: 'REGIONAL',      language: 'PA' },
  { name: 'TV One',             port: 3060, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Ravi TV',            port: 3116, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Aruj TV',            port: 3020, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'AAN TV HD',          port: 3052, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Bol Entertainment',  port: 3098, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'ARY Music',          port: 3106, category: 'MUSIC',         language: 'UR' },
  { name: 'Hum Sitary',         port: 3034, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Kashish TV',         port: 2080, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Paigham TV',         port: 3036, category: 'RELIGIOUS',     language: 'UR' },
  { name: 'Aaj Entertainment',  port: 2040, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Silver Screen',      port: 3038, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'KTN Entertainment',  port: 2078, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'ARY Zindagi',        port: 3100, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Roze Excel TV',      port: 2100, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'TV Today',           port: 3074, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Fast Sports',        port: 3178, category: 'SPORTS',        language: 'UR' },
  { name: 'PTV National',       port: 3042, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'PTV Global',         port: 2016, category: 'ENTERTAINMENT', language: 'EN' },
  { name: 'PTV Sports',         port: 2018, category: 'SPORTS',        language: 'UR' },
  { name: 'PTV Bolan (Home)',   port: 2010, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'City 21',            port: 2008, category: 'REGIONAL',      language: 'UR' },
  { name: 'A Sports',           port: 3110, category: 'SPORTS',        language: 'UR' },
  { name: 'Sun HD',             port: 3120, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Venus HD',           port: 3084, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Chaupaal',           port: 2030, category: 'ENTERTAINMENT', language: 'UR' },
  { name: 'Express 24/7',       port: 2032, category: 'ENTERTAINMENT', language: 'UR' },

  // ---- International (Table 2)
  { name: 'Star News Asia',                 port: 2074, category: 'NEWS', language: 'EN' },
  { name: 'DD News',                        port: 3136, category: 'NEWS', language: 'EN' },
  { name: 'DD India',                       port: 3160, category: 'NEWS', language: 'EN' },
  { name: 'Afghanistan National Radio TV',  port: 3028, category: 'NEWS', language: 'OTHER' },
  { name: 'News 24 India',                  port: 3144, category: 'NEWS', language: 'EN' },
  { name: 'Zee News',                       port: 3150, category: 'NEWS', language: 'EN' },
  { name: 'NDTV India',                     port: 3152, category: 'NEWS', language: 'EN' },
  { name: 'News 18 India',                  port: 3154, category: 'NEWS', language: 'EN' },
  { name: 'RT News',                        port: 3010, category: 'NEWS', language: 'EN' },
  { name: 'Times Now',                      port: 3158, category: 'NEWS', language: 'EN' },
  { name: 'DW English HD',                  port: 3164, category: 'NEWS', language: 'EN' },
  { name: 'Al Jazeera English',             port: 3166, category: 'NEWS', language: 'EN' },
  { name: 'TRT World HD',                   port: 3170, category: 'NEWS', language: 'EN' },
  { name: 'NHK World Japan',                port: 3168, category: 'NEWS', language: 'EN' },
  { name: 'ABP News',                       port: 3140, category: 'NEWS', language: 'EN' },
  { name: 'BBC News Arabic',                port: 3172, category: 'NEWS', language: 'AR' },
  { name: 'CNN',                            port: 3176, category: 'NEWS', language: 'EN' },
  { name: 'Al Arabiya',                     port: 3040, category: 'NEWS', language: 'AR' },
  { name: 'Aaj Tak India',                  port: 3146, category: 'NEWS', language: 'EN' },

  // ---- HDMI Encoder UDP (Table 3)
  { name: 'CNBC',              port: 5000, category: 'BUSINESS', language: 'EN' },
  { name: 'BBC News',          port: 5002, category: 'NEWS',     language: 'EN' },
  { name: 'CNN South Asia',    port: 5004, category: 'NEWS',     language: 'EN' },
  { name: 'France 24 News',    port: 5006, category: 'NEWS',     language: 'EN' },
  { name: 'CNN 18',            port: 5008, category: 'NEWS',     language: 'EN' },
  { name: 'Zee Punjabi',       port: 5010, category: 'ENTERTAINMENT', language: 'PA' },
  { name: 'India Today',       port: 5012, category: 'NEWS',     language: 'EN' },
  { name: 'NDTV 24/7',         port: 5014, category: 'NEWS',     language: 'EN' },
  { name: 'Al Jazeera Arabic', port: 5020, category: 'NEWS',     language: 'AR' },
  { name: 'Russian TV',        port: 5024, category: 'NEWS',     language: 'OTHER' },
  { name: 'NEW 7',             port: 5030, category: 'NEWS',     language: 'EN' },
];

const AI_ENABLED_SLUGS = new Set(['ary-news', 'dunya-news']);
const MULTICAST_IP     = process.env.UDP_MULTICAST_IP ?? '224.2.2.2';
const UDP_BASE_PORT    = 5000;   // dempOutputPort base for network re-broadcast

async function main() {
  console.log(`seeding ${CHANNELS.length} production channels · UDP host ${MULTICAST_IP} · AI enabled for: ${Array.from(AI_ENABLED_SLUGS).join(', ')}`);

  let created = 0, updated = 0, sourcesAdded = 0;
  const takenSlugs = new Set<string>();
  const takenOutputPorts = new Set<number>(
    (await prisma.channel.findMany({ select: { dempOutputPort: true } })).map((c) => c.dempOutputPort).filter((p): p is number => p !== null),
  );
  let nextOutputPort = UDP_BASE_PORT + 1;
  const nextFreeOutputPort = () => {
    while (takenOutputPorts.has(nextOutputPort)) nextOutputPort += 1;
    const p = nextOutputPort++;
    takenOutputPorts.add(p);
    return p;
  };

  for (const row of CHANNELS) {
    let slug = slugify(row.name);
    // Dedup slug within this run (name collisions shouldn't happen but be safe)
    let suffix = 2;
    while (takenSlugs.has(slug)) { slug = `${slugify(row.name)}-${suffix++}`; }
    takenSlugs.add(slug);

    const aiEnabled = AI_ENABLED_SLUGS.has(slug);
    const existing = await prisma.channel.findUnique({ where: { slug } });
    const outputPort = existing?.dempOutputPort ?? nextFreeOutputPort();

    const channel = await prisma.channel.upsert({
      where: { slug },
      update: {
        name: row.name,
        category: row.category,
        language: row.language,
        aiFeaturesEnabled: aiEnabled,
        dempOutputPort: outputPort,
        active: true,
      },
      create: {
        slug, name: row.name,
        category: row.category, language: row.language,
        aiFeaturesEnabled: aiEnabled,
        dempOutputPort: outputPort,
        active: true,
      },
    });
    if (existing) updated += 1; else created += 1;

    // Primary "Satellite" source at 224.2.2.2:PORT
    const url = `udp://@${MULTICAST_IP}:${row.port}`;
    const src = await prisma.source.findFirst({ where: { channelId: channel.id, url } });
    if (!src) {
      // Clear any prior primary flag if we're becoming primary
      await prisma.source.updateMany({ where: { channelId: channel.id }, data: { isPrimary: false } });
      await prisma.source.create({
        data: {
          channelId: channel.id,
          name: 'Satellite',
          kind: SourceKind.UDP,
          url,
          isPrimary: true,
          priority: 100,
        },
      });
      sourcesAdded += 1;
    }
  }

  const total = await prisma.channel.count();
  const enabledCount = await prisma.channel.count({ where: { aiFeaturesEnabled: true } });
  console.log(`done. created=${created} updated=${updated} sourcesAdded=${sourcesAdded} totalChannels=${total} aiEnabled=${enabledCount}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
