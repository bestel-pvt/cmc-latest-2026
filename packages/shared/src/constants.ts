export const CHANNEL_CATEGORIES = [
  'NEWS', 'ENTERTAINMENT', 'SPORTS', 'MUSIC', 'RELIGIOUS',
  'KIDS', 'BUSINESS', 'DOCUMENTARY', 'REGIONAL', 'OTHER',
] as const;

export const CHANNEL_LANGUAGES = ['EN', 'UR', 'AR', 'PA', 'OTHER'] as const;

export const SOURCE_KINDS = ['UDP', 'SRT', 'RTSP', 'RTMP', 'HLS', 'FILE'] as const;

export const CLIP_FORMATS = ['MP4', 'MOV', 'MKV', 'WEBM'] as const;
export const CLIP_RESOLUTIONS = ['3840x2160', '1920x1080', '1280x720', '854x480'] as const;

export const ROLES = ['ADMIN', 'OPERATOR', 'ANALYST', 'VIEWER'] as const;

/** Multiviewer grid presets */
export const GRID_LAYOUTS = [
  { id: '1x1', cols: 1, rows: 1, label: '1 × 1' },
  { id: '2x2', cols: 2, rows: 2, label: '2 × 2' },
  { id: '3x3', cols: 3, rows: 3, label: '3 × 3' },
  { id: '4x4', cols: 4, rows: 4, label: '4 × 4' },
] as const;

export const HEALTH_THRESHOLDS = {
  good: 0.75,
  ok:   0.5,
  bad:  0.25,
} as const;

export const AI_JOB_KINDS = [
  'TRANSCRIBE_SEGMENT',
  'TRANSCRIBE_CLIP',
  'OCR_TICKER',
  'GROUP_TICKERS',
  'RENDER_COLLAGE',
] as const;
export const AI_JOB_KIND_LABEL: Record<(typeof AI_JOB_KINDS)[number], string> = {
  TRANSCRIBE_SEGMENT: 'Segment Transcription',
  TRANSCRIBE_CLIP:    'Clip Transcription',
  OCR_TICKER:         'Ticker OCR',
  GROUP_TICKERS:      'Ticker Grouping',
  RENDER_COLLAGE:     'Collage Rendering',
};

export const OCR_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'ur', label: 'Urdu' },
  { code: 'hi', label: 'Hindi' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ar', label: 'Arabic' },
] as const;

/**
 * Feature-permission matrix used by the Users admin page.
 * Persisted on User.permissions as a list of "feature:action" strings, e.g.
 *   ["channels:write", "tickers:read", "gpt:read"]
 */
export const PERMISSION_FEATURES = [
  { key: 'channels',    label: 'Channels' },
  { key: 'multiviewer', label: 'Multiviewer' },
  { key: 'recordings',  label: 'Recordings' },
  { key: 'clips',       label: 'Clips' },
  { key: 'tickers',     label: 'Tickers' },
  { key: 'flashers',    label: 'Flashers' },
  { key: 'transcripts', label: 'Transcripts' },
  { key: 'alerts',      label: 'Alerts' },
  { key: 'gpt',         label: 'DEMP GPT' },
  { key: 'ai-health',   label: 'AI Health' },
  { key: 'users',       label: 'Users' },
  { key: 'audit',       label: 'Audit Log' },
  { key: 'legal-holds', label: 'Legal Holds' },
  { key: 'settings',    label: 'Settings' },
] as const;

export const PERMISSION_ACTIONS = [
  { key: 'read',  label: 'View' },
  { key: 'write', label: 'Modify' },
  { key: 'admin', label: 'Admin' },
] as const;

export function defaultPermissionsForRole(role: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER'): string[] {
  const all = PERMISSION_FEATURES.map((f) => f.key);
  if (role === 'ADMIN')    return all.flatMap((f) => [`${f}:read`, `${f}:write`, `${f}:admin`]);
  if (role === 'OPERATOR') return all.flatMap((f) => [`${f}:read`, `${f}:write`]).filter((p) => !p.startsWith('users:') && !p.startsWith('audit:') && !p.startsWith('settings:'));
  if (role === 'ANALYST')  return ['channels','multiviewer','recordings','clips','tickers','flashers','transcripts','alerts','gpt','ai-health'].flatMap((f) => [`${f}:read`]).concat(['clips:write','gpt:write','alerts:write']);
  return ['channels:read','multiviewer:read','recordings:read','clips:read','tickers:read','flashers:read','transcripts:read','alerts:read','gpt:read'];
}
