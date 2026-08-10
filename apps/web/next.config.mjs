/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@cmc/shared'],
  async rewrites() {
    // Server-side proxy target — Node 18+ resolves `localhost` to
    // IPv6 (::1) first, but Fastify defaults to IPv4 (0.0.0.0) only,
    // so `http://localhost:4001` reaches ::1 → ECONNREFUSED and the
    // page response is truncated for remote clients. Force IPv4.
    const proxy = process.env.INTERNAL_API_URL || 'http://127.0.0.1:4001';
    return [
      { source: '/api/:path*', destination: `${proxy}/api/:path*` },
    ];
  },
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};
export default nextConfig;
