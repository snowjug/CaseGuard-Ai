import { type BuildContext, parseUrl } from '../context';
import { splitList } from '../primitives';
import type { HttpConfig } from '../types';

const DEFAULT_LOCAL_ORIGIN = 'http://localhost:3000';

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
    trustProxy: raw.TRUST_PROXY ?? false,
    bodyLimitBytes: raw.BODY_LIMIT_BYTES ?? 1_048_576,
    uploadMaxBytes: raw.UPLOAD_MAX_BYTES ?? 2_097_152,
  };
}
