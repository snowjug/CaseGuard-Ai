import { NextResponse, type NextRequest } from 'next/server';

/**
 * Runtime forwarding of `/api/*` and the health endpoints to the API server.
 *
 * This lives in `src/proxy.ts` (not in `next.config.ts` `rewrites()`) because rewrites are frozen at build time, while
 * the container image is built once and configured at runtime: `API_INTERNAL_URL` is an environment variable of the
 * running container, so it is read on every request here.
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
 * Rewrites the request to the API origin. The method, headers and body travel to the API untouched (Next streams them),
 * and the API's response, including `x-request-id`, comes back untouched: no CSP or nonce is attached to it.
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
  return NextResponse.rewrite(target);
}
