/*
 * HTTP security headers shared by the web app (document responses) and the API (JSON responses).
 * This module is intentionally free of Node-only imports so it can be used from edge/web code.
 */

export interface ContentSecurityPolicyOptions {
  /** Per-response nonce for inline bootstrap scripts (base64 or base64url, 16-128 chars). */
  nonce?: string;
  /** Extra origins the browser may call, e.g. `https://login.microsoftonline.com`. */
  connectSrc?: readonly string[];
  /** Development builds need `'unsafe-eval'` (React Fast Refresh) and a WebSocket for HMR. */
  isDev?: boolean;
}

const NONCE_PATTERN = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/;
const ORIGIN_PATTERN = /^(?:https?|wss?):\/\/(?:\*\.)?[A-Za-z0-9][A-Za-z0-9.-]*(?::\d{1,5})?$/;

function assertNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) {
    throw new TypeError('CSP nonce must be 16-128 base64/base64url characters');
  }
}

/** Only plain origins are accepted so a caller can never inject a new directive or keyword. */
function assertConnectSource(source: string): void {
  if (source.length > 253 || !ORIGIN_PATTERN.test(source)) {
    throw new TypeError('CSP connect-src entries must be http(s)/ws(s) origins without a path');
  }
}

/**
 * Builds the `Content-Security-Policy` for HTML responses.
 *
 * `style-src` keeps `'unsafe-inline'`: Fluent UI v9 (Griffel) injects `<style>` elements at runtime
 * and cannot attach a nonce to them. The risk is bounded because scripts stay locked to the nonce
 * and `'strict-dynamic'`, `object-src` is `'none'`, and all user content is rendered as text.
 */
export function buildContentSecurityPolicy(options: ContentSecurityPolicyOptions = {}): string {
  const { nonce, connectSrc = [], isDev = false } = options;
  if (nonce !== undefined) assertNonce(nonce);
  for (const source of connectSrc) assertConnectSource(source);

  const scriptSrc = ["'self'"];
  if (nonce !== undefined) scriptSrc.push(`'nonce-${nonce}'`, "'strict-dynamic'");
  if (isDev) scriptSrc.push("'unsafe-eval'");

  const connect = ["'self'", ...connectSrc];
  if (isDev) connect.push('ws:', 'wss:');

  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', scriptSrc],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:']],
    ['connect-src', connect],
    ['frame-ancestors', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['object-src', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

/** CSP for JSON API responses: nothing may be loaded, framed or submitted. */
export const API_CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/** Headers that are safe on every response, regardless of transport. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
});

/** HSTS is only meaningful (and only honoured) over HTTPS, so it is kept apart from the rest. */
export const HSTS_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
});

/** `SECURITY_HEADERS`, plus HSTS when the response is served over HTTPS. */
export function buildSecurityHeaders(options: {
  secureTransport: boolean;
}): Record<string, string> {
  return options.secureTransport
    ? { ...SECURITY_HEADERS, ...HSTS_HEADERS }
    : { ...SECURITY_HEADERS };
}
