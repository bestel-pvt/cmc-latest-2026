import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1440px' } },
    extend: {
      fontFamily: {
        sans: ['Manrope', '"Noto Nastaliq Urdu"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['Sora', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"Source Code Pro"', 'ui-monospace', 'monospace'],
        urdu: ['"Noto Nastaliq Urdu"', 'Manrope', 'ui-sans-serif', 'sans-serif'],
      },
      colors: {
        // Light theme surfaces
        ink:       '#0F172A',                 // dark text
        bg:        '#F5F7FB',                 // page background
        bg2:       '#EDF1F8',                 // subtle alt
        panel:     '#FFFFFF',                 // card surface
        panel2:    '#F3F5FA',                 // hover/nested surface
        line:      'rgba(15,23,42,0.08)',
        line2:     'rgba(15,23,42,0.15)',
        txt:       '#0F172A',                 // primary text
        muted:     '#64748B',                 // secondary text
        'muted-2': '#94A3B8',                 // tertiary text

        // Deep navy retained only for occasional dark accents (unused by default now)
        navy:      '#0B1E3A',
        navy2:     '#132A55',

        // Brand palette — dark forest/emerald green
        brand:   { DEFAULT: '#15803D', 2: '#166534' },
        accent:  {
          red:    '#E11D48',
          purple: '#7C3AED',
          blue:   '#2563EB',
          cyan:   '#0891B2',
          green:  '#15803D',
          amber:  '#D97706',
        },

        // shadcn aliases
        background: '#F5F7FB',
        foreground: '#0F172A',
        card:       '#FFFFFF',
        border:     'rgba(15,23,42,0.08)',
        input:      'rgba(15,23,42,0.10)',
        ring:       '#15803D',
        primary:    { DEFAULT: '#15803D', foreground: '#FFFFFF' },
        secondary:  { DEFAULT: '#EEF2F7', foreground: '#0F172A' },
        destructive:{ DEFAULT: '#E11D48', foreground: '#FFFFFF' },
        popover:    { DEFAULT: '#FFFFFF', foreground: '#0F172A' },
      },
      borderRadius: { lg: '0.75rem', md: '0.5rem', sm: '0.375rem' },
      backgroundImage: {
        'g-brand':    'linear-gradient(95deg,#16A34A,#166534)',
        'g-spectrum': 'linear-gradient(92deg,#22C55E 0%,#0891B2 34%,#2563EB 66%,#7C3AED 100%)',
        'g-cyan':     'linear-gradient(135deg,#22D3EE,#2563EB)',
        'g-green':    'linear-gradient(135deg,#22C55E,#166534)',
        'g-purple':   'linear-gradient(135deg,#A78BFA,#6D28D9)',
        'g-navy':     'linear-gradient(135deg,#0B1E3A,#132A55)',
        'grid-lines': 'linear-gradient(rgba(15,23,42,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(15,23,42,.045) 1px,transparent 1px)',
      },
      boxShadow: {
        soft: '0 4px 20px -8px rgba(15,23,42,0.10), 0 2px 6px -2px rgba(15,23,42,0.05)',
        glow: '0 8px 24px -6px rgba(22,101,52,0.35)',
        lift: '0 12px 40px -12px rgba(15,23,42,0.14)',
      },
      keyframes: {
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.35' } },
        shimmer:  { '0%': { backgroundPosition: '-500px 0' }, '100%': { backgroundPosition: '500px 0' } },
      },
      animation: {
        'pulse-dot': 'pulseDot 1.4s ease-in-out infinite',
        shimmer:     'shimmer 1.8s linear infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
export default config;
