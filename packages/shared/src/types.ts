// ---------- Redis hot-state shapes (documented; not persisted in Postgres) ----------

export interface SourceHealth {
  sourceId: string;
  channelId: string;
  score: number;              // 0..1 rolling
  bitrateBps: number;
  packetLossPct: number;      // 0..100
  decodeErrors: number;
  pidContinuityErrors: number;
  blackPct: number;           // 0..100 of the last 10s
  silencePct: number;
  lastPacketAt: number;       // epoch ms
  updatedAt: number;
}

export interface ChannelRuntimeState {
  channelId: string;
  slug: string;
  activeSourceId: string | null;
  lastSwitchAt: number | null;
  reason: string | null;
}

// ---------- WebSocket event envelope ----------
export type WsEvent =
  | { type: 'channel.health';        channelId: string; data: SourceHealth[] }
  | { type: 'channel.source-switch'; channelId: string; fromSourceId: string | null; toSourceId: string; reason: string; at: number }
  | { type: 'channel.transcript';    channelId: string; segmentId: string; language: string; words: Array<{ t: number; d: number; w: string }>; text: string }
  | { type: 'channel.segment';       channelId: string; segmentId: string; startedAt: string; durationMs: number }
  | { type: 'channel.alert';         channelId: string; alertId: string; kind: string; matchedText?: string; severity: number };
