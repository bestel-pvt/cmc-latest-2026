import type { PrismaClient } from '@cmc/db';

export interface Citation {
  sourceType: 'TRANSCRIPT' | 'TICKER_EVENT' | 'FLASHER_EVENT' | 'ALERT' | 'CHANNEL' | 'CLIP';
  sourceId: string;
  channelId?: string | null;
  channelName?: string | null;
  snippet: string;
  at?: string;
  language?: string;
}

const STOPWORDS = new Set([
  'the','a','an','and','or','but','if','then','so','on','in','at','of','for','to','with','by','is','are','was','were','be','been','it','this','that','these','those','not','no','do','does','did','you','me','we','us','they','them','he','she','him','her','my','your','our','their','can','could','should','would','may','might','from','as','than','because','about','into','over','under','again','also',
  // roman urdu chatter
  'aur','ka','ki','ke','me','mein','par','se','ho','hai','hain','tha','thi','the','ya','ye','ap','apki','apka','wo','iski','iska','koi','kya','kese','kaise','kb','kab','bhi','kar','karo','krna','krne','krta','krti','kro','kren','abhi','abb','phr','phir','waghera','warna','magar','lekin',
]);

function keywords(q: string): string[] {
  const words = q.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const uniq = new Set<string>();
  for (const w of words) {
    if (w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    uniq.add(w);
  }
  return Array.from(uniq).slice(0, 12);
}

/**
 * Cheap keyword + recency retrieval over transcripts, tickers, flashers,
 * alerts. Returns up to `limit` citations, ranked by "how many query
 * keywords the snippet contains" then by recency.
 *
 * This is deliberately simple for Phase 3. A follow-on adds bge-m3 embeddings
 * over the same tables for real semantic recall.
 */
export async function retrieve(prisma: PrismaClient, query: string, opts?: { limit?: number; channelId?: string }): Promise<Citation[]> {
  const limit = opts?.limit ?? 20;
  const kws = keywords(query);
  if (kws.length === 0) {
    // Fall back to "most recent" across sources.
    return recencyFallback(prisma, limit, opts?.channelId);
  }

  // Build an ILIKE ANY(ARRAY[...]) — Postgres regex OR list.
  const patterns = kws.map((k) => `%${k}%`);

  const [transcripts, tickers, flashers, alerts] = await Promise.all([
    prisma.$queryRawUnsafe<Array<{
      id: string; text: string; language: string; at: Date;
      channelId: string; channelName: string;
    }>>(`
      SELECT t.id, t.text, t.language, s."startedAt" AS at, c.id as "channelId", c.name as "channelName"
      FROM "Transcript" t
      JOIN "RecordingSegment" s ON s.id = t."segmentId"
      JOIN "Channel" c ON c.id = s."channelId"
      WHERE t.text ILIKE ANY($1::text[])
      ${opts?.channelId ? 'AND c.id = $2' : ''}
      ORDER BY s."startedAt" DESC
      LIMIT 40
    `, patterns, ...(opts?.channelId ? [opts.channelId] : [])),

    prisma.$queryRawUnsafe<Array<{
      id: string; text: string; language: string; at: Date;
      channelId: string; channelName: string;
    }>>(`
      SELECT e.id, e.text, e.language, e."startedAt" AS at, c.id as "channelId", c.name as "channelName"
      FROM "TickerEvent" e JOIN "Channel" c ON c.id = e."channelId"
      WHERE e.kind = 'TICKER' AND e.text ILIKE ANY($1::text[])
      ${opts?.channelId ? 'AND c.id = $2' : ''}
      ORDER BY e."startedAt" DESC
      LIMIT 60
    `, patterns, ...(opts?.channelId ? [opts.channelId] : [])),

    prisma.$queryRawUnsafe<Array<{
      id: string; text: string; language: string; at: Date;
      channelId: string; channelName: string;
    }>>(`
      SELECT e.id, e.text, e.language, e."startedAt" AS at, c.id as "channelId", c.name as "channelName"
      FROM "TickerEvent" e JOIN "Channel" c ON c.id = e."channelId"
      WHERE e.kind IN ('FLASHER_LEFT','FLASHER_RIGHT') AND e.text ILIKE ANY($1::text[])
      ${opts?.channelId ? 'AND c.id = $2' : ''}
      ORDER BY e."startedAt" DESC
      LIMIT 30
    `, patterns, ...(opts?.channelId ? [opts.channelId] : [])),

    prisma.$queryRawUnsafe<Array<{
      id: string; matchedText: string | null; kind: string; at: Date;
      channelId: string | null; channelName: string | null;
    }>>(`
      SELECT a.id, a."matchedText", a.kind, a."createdAt" AS at,
             a."channelId", c.name AS "channelName"
      FROM "Alert" a LEFT JOIN "Channel" c ON c.id = a."channelId"
      WHERE a."matchedText" IS NOT NULL AND a."matchedText" ILIKE ANY($1::text[])
      ${opts?.channelId ? 'AND a."channelId" = $2' : ''}
      ORDER BY a."createdAt" DESC
      LIMIT 20
    `, patterns, ...(opts?.channelId ? [opts.channelId] : [])),
  ]);

  function scoreText(text: string): number {
    const t = text.toLowerCase();
    let hits = 0;
    for (const kw of kws) if (t.includes(kw)) hits += 1;
    return hits;
  }

  const all: Array<Citation & { _score: number; _at: number }> = [];

  for (const r of transcripts) {
    all.push({
      sourceType: 'TRANSCRIPT', sourceId: r.id, channelId: r.channelId, channelName: r.channelName,
      snippet: extractSnippet(r.text, kws, 260), at: r.at.toISOString(), language: r.language,
      _score: scoreText(r.text), _at: r.at.getTime(),
    });
  }
  for (const r of tickers) {
    all.push({
      sourceType: 'TICKER_EVENT', sourceId: r.id, channelId: r.channelId, channelName: r.channelName,
      snippet: r.text, at: r.at.toISOString(), language: r.language,
      _score: scoreText(r.text) + 0.2, _at: r.at.getTime(),
    });
  }
  for (const r of flashers) {
    all.push({
      sourceType: 'FLASHER_EVENT', sourceId: r.id, channelId: r.channelId, channelName: r.channelName,
      snippet: r.text, at: r.at.toISOString(), language: r.language,
      _score: scoreText(r.text) + 0.4, _at: r.at.getTime(),
    });
  }
  for (const r of alerts) {
    all.push({
      sourceType: 'ALERT', sourceId: r.id, channelId: r.channelId ?? null, channelName: r.channelName ?? null,
      snippet: `[${r.kind}] ${r.matchedText ?? ''}`, at: r.at.toISOString(),
      _score: scoreText(r.matchedText ?? '') + 0.1, _at: r.at.getTime(),
    });
  }

  all.sort((a, b) => (b._score - a._score) || (b._at - a._at));

  // Dedupe near-identical snippets (same normalized text within 30s window).
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of all) {
    const key = c.snippet.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    const { _score, _at, ...pub } = c; void _score; void _at;
    out.push(pub);
    if (out.length >= limit) break;
  }
  return out;
}

function extractSnippet(text: string, kws: string[], max: number): string {
  const lower = text.toLowerCase();
  for (const kw of kws) {
    const idx = lower.indexOf(kw);
    if (idx === -1) continue;
    const start = Math.max(0, idx - Math.floor(max / 3));
    const end = Math.min(text.length, start + max);
    return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
  }
  return text.slice(0, max);
}

async function recencyFallback(prisma: PrismaClient, limit: number, channelId?: string): Promise<Citation[]> {
  const [tickers, transcripts] = await Promise.all([
    prisma.tickerEvent.findMany({
      where: channelId ? { channelId } : undefined,
      orderBy: { startedAt: 'desc' }, take: limit,
      include: { channel: { select: { id: true, name: true } } },
    }),
    prisma.transcript.findMany({
      where: channelId ? { segment: { channelId } } : undefined,
      orderBy: { createdAt: 'desc' }, take: Math.floor(limit / 2),
      include: { segment: { include: { channel: { select: { id: true, name: true } } } } },
    }),
  ]);
  const out: Citation[] = [];
  for (const t of tickers) {
    out.push({
      sourceType: t.kind === 'TICKER' ? 'TICKER_EVENT' : 'FLASHER_EVENT',
      sourceId: t.id, channelId: t.channelId, channelName: t.channel.name,
      snippet: t.text, at: t.startedAt.toISOString(), language: t.language,
    });
  }
  for (const t of transcripts) {
    out.push({
      sourceType: 'TRANSCRIPT', sourceId: t.id, channelId: t.segment.channelId,
      channelName: t.segment.channel.name,
      snippet: t.text.slice(0, 260) + (t.text.length > 260 ? '…' : ''),
      at: t.segment.startedAt.toISOString(), language: t.language,
    });
  }
  return out.slice(0, limit);
}

/**
 * Build the system + context messages given a set of citations. Instructs the
 * model to answer *only* from the provided context and to cite by number.
 */
export function buildRagPrompt(citations: Citation[], userTurns: Array<{ role: 'user' | 'assistant'; content: string }>) {
  const context = citations.length === 0
    ? '(no matching context found in the monitored channels — say so plainly and offer to broaden the query.)'
    : citations.map((c, i) => {
        const src = c.sourceType === 'TICKER_EVENT' ? 'ticker'
                  : c.sourceType === 'FLASHER_EVENT' ? 'flasher'
                  : c.sourceType === 'TRANSCRIPT' ? 'transcript'
                  : c.sourceType === 'ALERT' ? 'alert'
                  : 'source';
        const ts = c.at ? new Date(c.at).toISOString().replace('T', ' ').slice(0, 19) : '?';
        return `[${i + 1}] (${src} · ${c.channelName ?? '—'} · ${ts})\n${c.snippet}`;
      }).join('\n\n');

  const system: { role: 'system'; content: string } = {
    role: 'system',
    content: [
      `You are DEMP GPT — the AI assistant for the DEMP (Directorate of Electronic Media & Publications) broadcast-monitoring platform, powered by Analysys AI.`,
      ``,
      `RULES:`,
      `1. Answer using ONLY the CONTEXT below. Do not use outside knowledge or the internet.`,
      `2. If the context does not contain enough information to answer, say so plainly (in the user's language) and suggest what to broaden — do not guess.`,
      `3. Cite sources inline using bracketed numbers like [1], [3] that match the CONTEXT entries. Every factual claim must have a citation.`,
      `4. Reply in the same language as the user's question. If the user writes Roman Urdu, reply in Roman Urdu.`,
      `5. Keep answers concise and factual. Use bullet points when listing more than 2 items.`,
      ``,
      `CONTEXT (from the monitored broadcast archive):`,
      context,
    ].join('\n'),
  };

  return [system, ...userTurns] as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
}
