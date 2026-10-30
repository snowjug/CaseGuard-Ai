import { isIP } from 'node:net';
import { type BuildContext, parseUrl } from '../context';
import { splitList } from '../primitives';
import type { HttpConfig, TrustProxySetting } from '../types';

const DEFAULT_LOCAL_ORIGIN = 'http://localhost:3000';

const PROXY_KEYWORDS: ReadonlySet<string> = new Set(['loopback', 'linklocal', 'uniquelocal']);

/** An address, a CIDR range (`10.0.0.0/8`) or one of the keywords the proxy-address matcher knows. */
function isTrustedProxyEntry(entry: string): boolean {
  if (PROXY_KEYWORDS.has(entry.toLowerCase())) return true;
  const [address = '', prefix, ...rest] = entry.split('/');
  const family = isIP(address);
  if (family === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (family === 4 ? 32 : 128);
}

/**
 * `X-Forwarded-For` is only as honest as the proxies that wrote it. Trusting every hop (`true`) lets
 * a client choose the address the rate limiter and the audit log see, so deployed environments should
 * name the number of proxies in front of the API instead.
 */
function parseTrustProxy(ctx: BuildContext): TrustProxySetting {
  const configured = ctx.raw.TRUST_PROXY;
  if (configured === undefined) return false;
  if (Array.isArray(configured)) {
    if (!configured.every(isTrustedProxyEntry)) {
      ctx.fail(
        'TRUST_PROXY',
        'list entries must be IP addresses, CIDR ranges, loopback, linklocal or uniquelocal',
      );
      return false;
    }
    return [...configured];
  }
  if (configured === true && ctx.deployed) {
    ctx.warn(
      'TRUST_PROXY=true trusts every X-Forwarded-For hop, so a client can choose the address used for rate limits and audit logs. Set the number of proxies in front of the API (for example 1) instead.',
    );
  }
  return configured;
}

/** Validates the browser origin allowlist. A wildcard is never accepted; deployed origins must be HTTPS. */
function parseOrigins(ctx: BuildContext): string[] {
  const configured = ctx.raw.CORS_ALLOWED_ORIGINS;
  if (configured === undefined) {
    if (ctx.deployed) {
      ctx.fail('CORS_ALLOWED_ORIGINS', "must be set to the web application's HTTPS origin");
      return [];
    }
    return [DEFAULT_LOCAL_ORIGIN];
  }

  const origins = new Set<string>();
  for (const entry of splitList(configured)) {
    if (entry.includes('*')) {
      ctx.fail('CORS_ALLOWED_ORIGINS', 'wildcard origins are not allowed; list each origin');
      continue;
    }
    const url = parseUrl(entry, ['http:', 'https:']);
    if (!url) {
      ctx.fail('CORS_ALLOWED_ORIGINS', 'every entry must be an absolute http(s) origin');
      continue;
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') {
      ctx.fail(
        'CORS_ALLOWED_ORIGINS',
        'entries must be bare origins (scheme, host, optional port)',
      );
      continue;
    }
    if (ctx.deployed && url.protocol !== 'https:') {
      ctx.fail(
        'CORS_ALLOWED_ORIGINS',
        'origins must use https when APP_ENV is staging or production',
      );
      continue;
    }
    if (ctx.production && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) {
      ctx.warn('CORS_ALLOWED_ORIGINS includes a loopback origin in production.');
    }
    origins.add(url.origin);
  }
  if (origins.size === 0 && splitList(configured).length === 0) {
    ctx.fail('CORS_ALLOWED_ORIGINS', 'must list at least one origin');
  }
  return [...origins];
}

export function buildHttp(ctx: BuildContext): HttpConfig {
  const { raw } = ctx;
  return {
    host: raw.API_HOST ?? '0.0.0.0',
    port: raw.API_PORT ?? 4000,
    corsAllowedOrigins: parseOrigins(ctx),
    trustProxy: parseTrustProxy(ctx),
    trustClientIpHeader: raw.TRUST_CLIENT_IP_HEADER ?? false,
    bodyLimitBytes: raw.BODY_LIMIT_BYTES ?? 1_048_576,
    uploadMaxBytes: raw.UPLOAD_MAX_BYTES ?? 2_097_152,
  };
}
