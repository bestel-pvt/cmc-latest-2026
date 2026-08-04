/* eslint-disable no-console */
/**
 * CMC (PAK NAVY) seed — 32 channels from the DGPR reference sheet.
 * Two entries (India Today, NDTV) have no IP/port and are seeded
 * active=false so they render dimmed in the picker.
 */
import { PrismaClient, Role, ChannelCategory, ChannelLanguage, SourceKind } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

interface Seed {
  slug: string;
  name: string;
  category: ChannelCategory;
  language: ChannelLanguage;
  ip?: string;   // undefined = offline (India Today, NDTV)
  port?: number;
}

// From `DGPR Channels List.xlsx` — 32 rows.
const CHANNELS: Seed[] = [
  { slug: 'ptv-news',       name: 'PTV News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.5',  port: 1111 },
  { slug: 'ptv-world',      name: 'PTV World',      category: ChannelCategory.NEWS,          language: ChannelLanguage.EN, ip: '239.1.1.61', port: 1111 },
  { slug: 'geo-news',       name: 'GEO News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.8',  port: 1111 },
  { slug: 'ary-news',       name: 'ARY News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.9',  port: 1111 },
  { slug: 'abb-tak',        name: 'Abb Tak',        category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.26', port: 1111 },
  { slug: 'express-news',   name: 'Express News',   category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.16', port: 1111 },
  { slug: 'samaa-news',     name: 'SAMAA News',     category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.6',  port: 1111 },
  { slug: 'news-one',       name: 'News One',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.28', port: 1111 },
  { slug: 'dunya-news',     name: 'Dunya News',     category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.7',  port: 1111 },
  { slug: 'neo-news',       name: 'Neo News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.13', port: 1111 },
  { slug: 'suno-news',      name: 'Suno News',      category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.10', port: 1111 },
  { slug: 'bol-news',       name: 'BOL News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.19', port: 1111 },
  { slug: '92-news',        name: '92 News',        category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.14', port: 1111 },
  { slug: '24-news',        name: '24 News',        category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.17', port: 1111 },
  { slug: 'gnn-news',       name: 'GNN News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.30', port: 1111 },
  { slug: 'dawn-news',      name: 'Dawn News',      category: ChannelCategory.NEWS,          language: ChannelLanguage.EN, ip: '239.1.1.27', port: 1111 },
  { slug: 'hum-news',       name: 'HUM News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.18', port: 1111 },
  { slug: 'aaj-news',       name: 'Aaj News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.12', port: 1111 },
  { slug: 'public-news',    name: 'Public News',    category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.25', port: 1111 },
  { slug: 'aik-news',       name: 'Aik News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.38', port: 1111 },
  { slug: '365-news',       name: '365 News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.41', port: 1111 },
  { slug: 'capital-news',   name: 'Capital News',   category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.11', port: 1111 },
  { slug: 'abn-news',       name: 'ABN News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.57', port: 1111 },
  { slug: 'gtv-news',       name: 'GTV News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.45', port: 1111 },
  { slug: 'k21-news',       name: 'K21 News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.51', port: 1111 },
  { slug: 'city-41-news',   name: 'City 41 News',   category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.52', port: 1111 },
  { slug: 'city-42-news',   name: 'City 42 News',   category: ChannelCategory.NEWS,          language: ChannelLanguage.UR, ip: '239.1.1.53', port: 1111 },
  { slug: 'india-today',    name: 'India Today',    category: ChannelCategory.NEWS,          language: ChannelLanguage.EN, /* no IP — offline */ },
  { slug: 'ndtv',           name: 'NDTV',           category: ChannelCategory.NEWS,          language: ChannelLanguage.EN, /* no IP — offline */ },
  { slug: 'aljazeera-news', name: 'Al Jazeera News', category: ChannelCategory.NEWS,         language: ChannelLanguage.EN, ip: '239.1.1.73', port: 1111 },
  { slug: 'bbc-news',       name: 'BBC News',       category: ChannelCategory.NEWS,          language: ChannelLanguage.EN, ip: '239.1.1.63', port: 1111 },
  { slug: 'cnn',            name: 'CNN',            category: ChannelCategory.NEWS,          language: ChannelLanguage.EN, ip: '239.1.1.62', port: 1111 },
];

async function main() {
  // --- Admin user ---
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@cmc.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? 'cmc-admin-2026';
  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {},
    create: {
      email: adminEmail,
      name: 'System Administrator',
      passwordHash,
      role: Role.ADMIN,
    },
  });
  console.log(`admin: ${admin.email} / ${adminPassword}`);

  // --- 32 DGPR channels ---
  // dempOutputPort is unique — assign sequentially from 5100 upward so
  // each channel gets a distinct re-broadcast port even if the source
  // UDP port is shared.
  let outputPort = 5100;
  let created = 0, updated = 0;

  for (const c of CHANNELS) {
    const isOnline = !!c.ip;
    const existing = await prisma.channel.findUnique({ where: { slug: c.slug } });

    const chData = {
      name: c.name,
      slug: c.slug,
      category: c.category,
      language: c.language,
      active: isOnline,           // rows without IP → active=false (offline)
      aiFeaturesEnabled: true,    // CMC has no AI, but keep field truthy so
                                  // downstream code that filters on it works
      recordingEnabled: isOnline, // record every online channel
      dempOutputPort: existing?.dempOutputPort ?? outputPort++,
    };

    const ch = await prisma.channel.upsert({
      where: { slug: c.slug },
      update: chData,
      create: chData,
    });

    // Replace sources — one UDP entry if IP is known.
    await prisma.source.deleteMany({ where: { channelId: ch.id } });
    if (isOnline) {
      await prisma.source.create({
        data: {
          channelId: ch.id,
          kind: SourceKind.UDP,
          url: `udp://@${c.ip}:${c.port}`,
          isPrimary: true,
          priority: 100,
        },
      });
    }

    if (existing) updated += 1; else created += 1;
    console.log(`  ${isOnline ? '●' : '○'} ${c.slug.padEnd(20)} ${isOnline ? `udp://@${c.ip}:${c.port}` : '(offline — no IP)'}`);
  }

  console.log(`\n${CHANNELS.length} channels: ${created} new, ${updated} updated, ${CHANNELS.filter((c) => !c.ip).length} offline.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
