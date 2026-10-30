import { isIP } from 'node:net';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runtime forwarding of `/api/*` and the health endpoints to the API server.
 *
 * This lives in `src/proxy.ts` (not in `next.config.ts` `rewrites()`) because rewrites are frozen at build time, while
 * the container image is built once and configured at runtime: `API_INTERNAL_URL` is an environment variable of the
 * running container, so it is read on every request here.
 *
 * Next 16 runs the proxy on the Node.js runtime (it cannot be switched to Edge), so `node:net` is available.
 */

/** Where the API listens during local development. Never assumed in production. */
export const DEFAULT_API_ORIGIN = 'http://localhost:4000';

const HEALTH_PATHS: ReadonlySet<string> = new Set(['/livez', '/healthz', '/readyz']);

/** True for the paths that belong to the API: `/api` and everything under it, plus the health endpoints. */
export function isForwardedPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || HEALTH_PATHS.has(pathname);
}

export type ApiOriginResult = { ok: true; origin: string } | { ok: false; message: string };

const ORIGIN_HINT = 'an absolute http(s) origin such as http://api:4000';

function evaluate(raw: string | undefined, production: boolean): ApiOriginResult {
  const value = raw?.trim();
  if (!value) {
    return production
      ? { ok: false, message: `API_INTERNAL_URL is not set. Set it to ${ORIGIN_HINT}.` }
      : { ok: true, origin: DEFAULT_API_ORIGIN };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, message: `API_INTERNAL_URL is not a valid URL. Use ${ORIGIN_HINT}.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: `API_INTERNAL_URL must use http or https. Use ${ORIGIN_HINT}.` };
  }
  if (url.username || url.password) {
    return {
      ok: false,
      message: 'API_INTERNAL_URL must not contain credentials; they would end up in logs.',
    };
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    return {
      ok: false,
      message: `API_INTERNAL_URL must be only a scheme, host and port. Use ${ORIGIN_HINT}.`,
    };
  }
  return { ok: true, origin: url.origin };
}

let memo: { key: string; result: ApiOriginResult } | undefined;

/**
 * Validates `API_INTERNAL_URL`: an absolute http(s) origin. Missing means `http://localhost:4000` outside production
 * and a configuration error in production. The environment is read on every call (so a runtime variable is honoured)
 * but a given value is validated, and a failure logged, only once.
 */
export function resolveApiOrigin(
  raw: string | undefined = process.env.API_INTERNAL_URL,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): ApiOriginResult {
  const production = nodeEnv === 'production';
  const key = `${production ? 'production' : 'other'}|${raw ?? ''}`;
  if (memo?.key === key) return memo.result;
  const result = evaluate(raw, production);
  memo = { key, result };
  if (!result.ok) console.error(`[web] Forwarding to the API is disabled: ${result.message}`);
  return result;
}

const SAFE_CORRELATION_ID = /^[\w.:-]{1,80}$/;

/** An RFC 9457 problem+json answer, in the shape the API client parses (`ProblemSchema`). */
function problem(
  status: 400 | 502,
  code: string,
  title: string,
  detail: string,
  request: NextRequest,
): NextResponse {
  const correlation = request.headers.get('x-correlation-id') ?? '';
  const body = {
    type: `urn:caseguard:problem:${code.replaceAll('_', '-')}`,
    title,
    status,
    code,
    detail,
    ...(SAFE_CORRELATION_ID.test(correlation) ? { correlationId: correlation } : {}),
  };
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' },
  });
}

/**
 * Header that tells the API which address to rate-limit. The API sits behind this web tier, so without it every request
 * of a web replica would reach the API from that replica's own address and all of its visitors would share one bucket.
 * The API believes the header only when it runs with `TRUST_CLIENT_IP_HEADER=true`.
 */
export const CLIENT_IP_HEADER = 'x-cg-client-ip';

/** The longest textual IP address: `0000:0000:0000:0000:0000:ffff:255.255.255.255`. */
const MAX_IP_LENGTH = 45;
const IP_LITERAL = /^[\da-fA-F:.]+$/;
const PORT = /^\d{1,5}$/;

/**
 * True for a bare IPv4 or IPv6 literal and nothing else. Stricter than `net.isIP`, which also accepts an IPv6 zone id
 * (`fe80::1%eth0`): that suffix is free text and could be used to mint unlimited distinct rate-limit keys.
 */
export function isIpLiteral(value: string): boolean {
  return value.length <= MAX_IP_LENGTH && IP_LITERAL.test(value) && isIP(value) !== 0;
}

const isPort = (value: string): boolean => PORT.test(value) && Number(value) <= 65535;

/**
 * The IP address in one `x-forwarded-for` entry, or null. Ingresses write `203.0.113.7`, `203.0.113.7:54321`,
 * `2001:db8::7` or `[2001:db8::7]:54321`: ports and brackets are stripped and nothing else is tolerated.
 */
function addressOfEntry(entry: string): string | null {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    if (close === -1) return null;
    const address = entry.slice(1, close);
    const rest = entry.slice(close + 1);
    const validRest = rest === '' || (rest.startsWith(':') && isPort(rest.slice(1)));
    return validRest && isIpLiteral(address) && isIP(address) === 6 ? address : null;
  }
  const colon = entry.indexOf(':');
  if (colon !== -1 && colon === entry.lastIndexOf(':')) {
    // A single colon can only be `IPv4:port`; an IPv6 literal has at least two.
    const address = entry.slice(0, colon);
    return isPort(entry.slice(colon + 1)) && isIpLiteral(address) && isIP(address) === 4
      ? address
      : null;
  }
  return isIpLiteral(entry) ? entry : null;
}

/**
 * The client address our own ingress reported: the RIGHT-MOST entry of `x-forwarded-for`. The ingress appends the
 * address of the connection it accepted, so only the last entry was written by infrastructure we trust; everything to
 * its left was supplied by the client. When that last entry is not an IP address nothing is returned (the entries to
 * its left are deliberately not consulted) and the API falls back to the address it sees on the socket.
 *
 * Before the proxy runs, Next fills `x-forwarded-for` with the socket address when the header is absent, so in local
 * development this is the loopback address of the browser's connection.
 */
export function clientAddressFromForwardedFor(
  forwardedFor: string | null | undefined,
): string | null {
  if (!forwardedFor) return null;
  const entry = forwardedFor.slice(forwardedFor.lastIndexOf(',') + 1).trim();
  return entry === '' ? null : addressOfEntry(entry);
}

/**
 * The request headers the API receives: the caller's own, with `x-cg-client-ip` replaced by the address the ingress
 * reported. A `x-cg-client-ip` sent by the client is always dropped (it would let a caller choose its own rate-limit
 * bucket) and none is set when there is no usable address.
 *
 * Next applies `request.headers` as the COMPLETE set of upstream request headers, and removes any header that is not
 * in it, which is why this starts from a copy of every incoming header. Next ignores an empty list, which would leave a
 * client-sent `x-cg-client-ip` in place, but the list is never empty: Next adds the `x-forwarded-*` headers to every
 * request before the proxy runs (checked with a bare HTTP/1.0 request that carried nothing but the spoofed header).
 */
function upstreamHeaders(request: NextRequest): Headers {
  const headers = new Headers(request.headers);
  headers.delete(CLIENT_IP_HEADER);
  const address = clientAddressFromForwardedFor(request.headers.get('x-forwarded-for'));
  if (address) headers.set(CLIENT_IP_HEADER, address);
  return headers;
}

/**
 * Rewrites the request to the API origin. The method, body and headers travel to the API unchanged, except that
 * `x-cg-client-ip` is set by us (see `upstreamHeaders`), and the API's response, including `x-request-id`, comes back
 * without a CSP or nonce.
 */
export function forwardToApi(request: NextRequest): NextResponse {
  const resolved = resolveApiOrigin();
  if (!resolved.ok) {
    return problem(
      502,
      'upstream_not_configured',
      'The API is not configured',
      resolved.message,
      request,
    );
  }
  const { pathname, search } = request.nextUrl;
  const target = new URL(`${pathname}${search}`, resolved.origin);
  // The destination host is fixed by configuration and must never be influenced by the request path.
  if (target.origin !== resolved.origin) {
    return problem(400, 'bad_request', 'Bad request', 'The request path is not valid.', request);
  }
  return NextResponse.rewrite(target, { request: { headers: upstreamHeaders(request) } });
}
