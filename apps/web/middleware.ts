import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Next.js sends `Cache-Control: s-maxage=31536000, stale-while-revalidate`
// for statically-rendered app routes. That's fine for /_next/static/*
// (content-hashed, safe forever) but catastrophic for the HTML shell:
// after a redeploy the browser + any proxy hold onto the old shell,
// which references chunk hashes that no longer exist, and every open
// tab starts throwing ChunkLoadError until the operator hits Ctrl+F5.
//
// Override on the HTML shell and RSC payloads only. Static chunks are
// excluded by config.matcher below and keep their long cache.
export function middleware(_req: NextRequest) {
  const res = NextResponse.next();
  res.headers.set('Cache-Control', 'no-store, must-revalidate');
  return res;
}

export const config = {
  matcher: [
    // everything EXCEPT hashed static assets and the API proxy
    '/((?!_next/static|_next/image|favicon|hls|api/).*)',
  ],
};
