/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@cmc/shared'],
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4001';
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
    ];
  },
  images: { unoptimized: true },
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
};
export default nextConfig;
