import type { NextConfig } from 'next';

// In production Caddy routes /api/* and /ws to the api service (same origin).
// In dev, Next proxies them to the api process instead.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  output: 'standalone',
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/ws', destination: `${API_ORIGIN}/ws` },
    ];
  },
};

export default nextConfig;
