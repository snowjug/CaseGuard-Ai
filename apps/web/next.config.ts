import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));
const monorepoRoot = path.resolve(here, '../..');
const isProduction = process.env.NODE_ENV === 'production';

// The Content-Security-Policy is built per request (it carries a nonce) in src/proxy.ts; the static headers live here.
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  // Legacy equivalent of CSP frame-ancestors for browsers that ignore it.
  { key: 'X-Frame-Options', value: 'DENY' },
  ...(isProduction
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' }]
    : []),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // Parallel workers (and e2e runs) each need their own build directory: two `next dev` or `next build` processes
  // cannot share `.next`. Unset, this is the default.
  distDir: process.env.CG_NEXT_DIST_DIR?.trim() || '.next',
  // The standalone trace must include workspace packages that live outside apps/web.
  outputFileTracingRoot: monorepoRoot,
  // Workspace packages ship TypeScript sources (just-in-time packages).
  transpilePackages: ['@caseguard/schemas', '@caseguard/ui'],
  poweredByHeader: false,
  reactStrictMode: true,
  // `next dev` would otherwise write an AGENTS.md into the project when it detects an AI coding agent.
  agentRules: false,
  // The floating dev badge covers the bottom-left corner of every screenshot and the toast area.
  devIndicators: false,
  // /api/*, /livez, /healthz and /readyz are forwarded to the API at runtime by src/proxy.ts (rewrites() here would
  // bake API_INTERNAL_URL into the image at build time).
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
