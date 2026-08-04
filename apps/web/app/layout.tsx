import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: {
    default: 'PAK NAVY · Channel Monitoring & Clipping',
    template: '%s · PAK NAVY CMC',
  },
  description: 'AI-Powered Broadcast Monitoring & Media Intelligence — powered by Analysys',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* Fonts — swap to /fonts/*.woff2 for air-gap deployments. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Sora:wght@400;500;600;700&family=Manrope:wght@400;500;600;700&family=Noto+Nastaliq+Urdu:wght@400;500;600;700&family=Source+Code+Pro:wght@400;500&display=swap"
        />
      </head>
      <body className="min-h-screen">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
