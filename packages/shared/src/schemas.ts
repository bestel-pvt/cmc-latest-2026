import { z } from 'zod';

// ---------- Auth ----------
export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6).max(200),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(200),
  password: z.string().min(8).max(200),
  role: z.enum(['ADMIN', 'OPERATOR', 'ANALYST', 'VIEWER']),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// ---------- Channels ----------
export const upsertChannelSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).min(2).max(64),
  name: z.string().min(1).max(200),
  category: z.enum(['NEWS','ENTERTAINMENT','SPORTS','MUSIC','RELIGIOUS','KIDS','BUSINESS','DOCUMENTARY','REGIONAL','OTHER']),
  language: z.enum(['EN','UR','AR','PA','OTHER']),
  logoUrl: z.string().url().nullable().optional(),
  active: z.boolean().optional(),
  notes: z.string().max(1000).nullable().optional(),
  tickerCropRect: z.object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  }).nullable().optional(),
});
export type UpsertChannelInput = z.infer<typeof upsertChannelSchema>;

// ---------- Sources ----------
export const upsertSourceSchema = z.object({
  channelId: z.string().min(1),
  name: z.string().min(1, 'source name is required').max(80),
  kind: z.enum(['UDP', 'SRT', 'RTSP', 'RTMP', 'HLS', 'FILE']),
  url: z.string().min(1).max(1000),
  isPrimary: z.boolean().default(false),
  priority: z.number().int().min(0).max(100).default(0),
  notes: z.string().max(500).nullable().optional(),
});
export type UpsertSourceInput = z.infer<typeof upsertSourceSchema>;

// ---------- Clips ----------
export const createClipSchema = z.object({
  channelId: z.string().min(1),
  startAt: z.string().datetime(),     // ISO
  endAt:   z.string().datetime(),
  title:   z.string().min(1).max(200),
  notes:   z.string().max(1000).nullable().optional(),
  format:  z.enum(['MP4','MOV','MKV','WEBM']).default('MP4'),
  resolution: z.string().default('1920x1080'),
  watermarkText: z.string().max(200).nullable().optional(),
}).refine(
  (d) => new Date(d.endAt).getTime() > new Date(d.startAt).getTime(),
  { message: 'endAt must be greater than startAt', path: ['endAt'] },
);
export type CreateClipInput = z.infer<typeof createClipSchema>;

// ---------- Clip Merges ----------
// Operator picks N {channel, startAt, endAt} segments across any
// channels; worker renders each as a mezzanine then stitches them in
// `orderIdx` order into a single mp4.
export const clipMergeSegmentSchema = z.object({
  channelId: z.string().min(1),
  startAt:   z.string().datetime(),
  endAt:     z.string().datetime(),
}).refine(
  (d) => new Date(d.endAt).getTime() > new Date(d.startAt).getTime(),
  { message: 'endAt must be greater than startAt', path: ['endAt'] },
);
export type ClipMergeSegmentInput = z.infer<typeof clipMergeSegmentSchema>;

export const createClipMergeSchema = z.object({
  title:      z.string().min(1).max(200),
  notes:      z.string().max(1000).nullable().optional(),
  format:     z.enum(['MP4','MOV','MKV','WEBM']).default('MP4'),
  resolution: z.string().default('1920x1080'),
  segments:   z.array(clipMergeSegmentSchema).min(2).max(30),
});
export type CreateClipMergeInput = z.infer<typeof createClipMergeSchema>;

// ---------- Keywords ----------
export const upsertKeywordSchema = z.object({
  text: z.string().min(1).max(200),
  language: z.string().default('en'),
  active: z.boolean().default(true),
});
export type UpsertKeywordInput = z.infer<typeof upsertKeywordSchema>;

// ---------- Legal Holds ----------
export const createLegalHoldSchema = z.object({
  channelId: z.string().nullable().optional(),
  startsAt:  z.string().datetime(),
  endsAt:    z.string().datetime(),
  reason:    z.string().min(3).max(1000),
});
export type CreateLegalHoldInput = z.infer<typeof createLegalHoldSchema>;
