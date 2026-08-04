// =====================================================================
// DEMP / Analysys brand tokens
// Extracted from brochure.html — treat that file as the visual bible.
// =====================================================================

export const brand = {
  name: 'DEMP',
  tagline: 'AI-Powered Broadcast Monitoring & Media Intelligence',
  poweredBy: 'Analysys',
  poweredByUrl: 'https://analysys.tech',
} as const;

// Raw palette (do not use directly in components — go through Tailwind tokens).
export const palette = {
  ink:    '#060A15',
  bg:     '#0A1124',
  bg2:    '#0C1430',
  panel:  '#101A34',
  panel2: '#16203F',
  txt:    '#ECF1FF',
  muted:  '#94A3C4',
  muted2: '#6D7EA1',
  line:   'rgba(255,255,255,0.08)',
  line2:  'rgba(255,255,255,0.15)',

  // accents
  orange:  '#FF8A1E',
  orange2: '#FF5E1A',
  red:     '#FF4D6D',
  purple:  '#8B5CFF',
  blue:    '#3D86FF',
  cyan:    '#34D3E0',
  green:   '#22C76A',
  amber:   '#FFC23C',
} as const;

export const gradients = {
  brand:    'linear-gradient(95deg,#FF9A2E,#FF5A18)',
  spectrum: 'linear-gradient(92deg,#FF8A1E 0%,#FF4D6D 34%,#8B5CFF 66%,#3D86FF 100%)',
  cyan:     'linear-gradient(135deg,#3FDDE9,#2563EB)',
  green:    'linear-gradient(135deg,#34E3A0,#12A150)',
  purple:   'linear-gradient(135deg,#9F6BFF,#6D28D9)',
} as const;

export const fonts = {
  heading: 'Sora, ui-sans-serif, system-ui, sans-serif',
  body:    'Manrope, ui-sans-serif, system-ui, sans-serif',
  code:    '"Source Code Pro", ui-monospace, SFMono-Regular, monospace',
} as const;
