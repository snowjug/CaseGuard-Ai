import { NextResponse, type NextRequest } from 'next/server';
import { forwardToApi, isForwardedPath } from './lib/api-forward';
import { buildCsp, generateNonce } from './lib/csp';

/**
 * Next 16 "proxy" (the renamed middleware). It does two jobs:
 *
 * 1. `/api/*` and the health endpoints (`/livez`, `/healthz`, `/readyz`) are forwarded to the API at RUNTIME, from
 *    `API_INTERNAL_URL` (see `lib/api-forward.ts`). These responses never get a CSP or nonce: they are not documents.
 * 2. Page requests get a per-request CSP nonce. Next.js reads the nonce from the request's Content-Security-Policy
 *    header and applies it to its own scripts, which is why every page renders dynamically.
 */
export function proxy(request: NextRequest): NextResponse {
  if (isForwardedPath(request.nextUrl.pathname)) return forwardToApi(request);

  const nonce = generateNonce();
  // Behind a TLS-terminating ingress the app sees http, so the forwarded protocol decides.
  const forwarded = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const secure = (forwarded ?? request.nextUrl.protocol.replace(':', '')) === 'https';
  const csp = buildCsp({
    nonce,
    isDevelopment: process.env.NODE_ENV === 'development',
    entraAuthority: process.env.NEXT_PUBLIC_ENTRA_AUTHORITY,
    upgradeInsecureRequests: secure,
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  return response;
}

export const config = {
  matcher: [
    // The API and its health endpoints are always forwarded.
    '/api/:path*',
    '/livez',
    '/healthz',
    '/readyz',
    {
      // Pages get a nonce CSP; static assets are skipped, and so are prefetches so they stay cacheable.
      source: '/((?!api/|livez|healthz|readyz|_next/static|_next/image|favicon.ico|icon.svg).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
