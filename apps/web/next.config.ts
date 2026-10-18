import path from 'node:path';
import type { NextConfig } from 'next';

// In production Caddy routes /api/* and /ws to the api service (same origin).
// In dev, Next proxies them to the api process instead.
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  output: 'standalone',
  // The pnpm workspace root is the tracing root (the Dockerfile already
  // copies .next/standalone laid out from /repo). Pinning it stops Next from
  // guessing a different root when a stray lockfile sits above the checkout
  // (a ~/package-lock.json on a dev box made `next dev` pick $HOME).
  outputFileTracingRoot: path.join(__dirname, '../../'),
  devIndicators: false,
  async rewrites() {
    if (process.env.NODE_ENV === 'production') return [];
    return [
      { source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` },
      { source: '/ws', destination: `${API_ORIGIN}/ws` },
    ];
  },
};

export default nextConfig;
