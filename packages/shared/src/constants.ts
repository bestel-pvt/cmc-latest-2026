export const CHANNEL_CATEGORIES = [
  'NEWS', 'ENTERTAINMENT', 'SPORTS', 'MUSIC', 'RELIGIOUS',
  'KIDS', 'BUSINESS', 'DOCUMENTARY', 'REGIONAL', 'OTHER',
] as const;

export const CHANNEL_LANGUAGES = ['EN', 'UR', 'AR', 'PA', 'OTHER'] as const;

export const SOURCE_KINDS = ['UDP', 'SRT', 'RTSP', 'RTMP', 'HLS', 'FILE'] as const;

export const CLIP_FORMATS = ['MP4', 'MOV', 'MKV'] as const;
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
// Only pages/features that actually exist in the CMC build today.
// DEMP had AI, ticker/flasher OCR, alerts, legal-holds, DEMP-GPT — all
// stripped from this fork. If we add a feature back, add its key here
// and the Add-User dialog + defaultPermissionsForRole pick it up.
export const PERMISSION_FEATURES = [
  { key: 'dashboard',    label: 'Dashboard' },
  { key: 'multiviewer',  label: 'Video Wall' },
  { key: 'channels',     label: 'Channels' },
  { key: 'recordings',   label: 'Recordings' },
  { key: 'clips',        label: 'Clips' },
  { key: 'frames',       label: 'Frames' },
  { key: 'users',        label: 'Users (Admin)' },
  { key: 'audit',        label: 'Audit Log (Admin)' },
] as const;

export const PERMISSION_ACTIONS = [
  { key: 'read',  label: 'View' },
  { key: 'write', label: 'Modify' },
] as const;

/** Preset permission sets for the 3 built-in roles. Custom roleName +
 *  permissions array override this in the Add-User dialog. */
export function defaultPermissionsForRole(role: 'ADMIN' | 'OPERATOR' | 'ANALYST' | 'VIEWER'): string[] {
  const NON_ADMIN = ['dashboard','multiviewer','channels','recordings','clips','frames'];
  const ADMIN_ONLY = ['users','audit'];
  if (role === 'ADMIN') {
    // full read+write on every feature
    return [...NON_ADMIN, ...ADMIN_ONLY].flatMap((f) => [`${f}:read`, `${f}:write`]);
  }
  if (role === 'OPERATOR') {
    // read+write on operational surfaces, no admin pages
    return NON_ADMIN.flatMap((f) => [`${f}:read`, `${f}:write`]);
  }
  if (role === 'ANALYST') {
    // read everything operational + can edit clips + frames only
    return [
      ...NON_ADMIN.map((f) => `${f}:read`),
      'clips:write', 'frames:write',
    ];
  }
  // VIEWER — read-only operational
  return NON_ADMIN.map((f) => `${f}:read`);
}
