import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_API_ORIGIN, isForwardedPath, resolveApiOrigin } from './lib/api-forward';
import { config, proxy } from './proxy';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('[SEC-CSP-02] proxy.ts sets a fresh CSP nonce per request', () => {
  it('puts the nonce in the response policy and forwards it to the app on the request', () => {
    const response = proxy(new NextRequest('http://localhost:3000/'));
    const csp = response.headers.get('content-security-policy') ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(nonce).toBeTruthy();
    expect(response.headers.get('x-middleware-request-x-nonce')).toBe(nonce);
    expect(response.headers.get('x-middleware-request-content-security-policy')).toBe(csp);
  });

  it('never reuses a nonce', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const csp =
        proxy(new NextRequest('http://localhost:3000/')).headers.get('content-security-policy') ??
        '';
      nonces.add(/'nonce-([^']+)'/.exec(csp)?.[1] ?? '');
    }
    expect(nonces.size).toBe(5);
  });

  it('upgrades insecure requests only when the request arrived over https', () => {
    const header = 'content-security-policy';
    const plain = proxy(new NextRequest('http://192.168.1.20:3000/')).headers.get(header);
    const behindTls = proxy(
      new NextRequest('http://app:3000/', { headers: { 'x-forwarded-proto': 'https' } }),
    ).headers.get(header);
    expect(plain).not.toContain('upgrade-insecure-requests');
    expect(behindTls).toContain('upgrade-insecure-requests');
  });
});

const rewriteOf = (response: Response): string | null =>
  response.headers.get('x-middleware-rewrite');

describe('[API-FWD-01] /api/* and the health endpoints are forwarded at runtime', () => {
  beforeEach(() => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:4000');
  });

  it('recognises exactly the API paths', () => {
    for (const path of ['/api', '/api/v1/me', '/livez', '/healthz', '/readyz'])
      expect(isForwardedPath(path), path).toBe(true);
    for (const path of ['/', '/apiary', '/api-docs', '/cases', '/livez/extra', '/health'])
      expect(isForwardedPath(path), path).toBe(false);
  });

  it('reads API_INTERNAL_URL on every request, so a runtime change is honoured', () => {
    const first = proxy(new NextRequest('http://localhost:3000/api/v1/me'));
    expect(rewriteOf(first)).toBe('http://api.internal:4000/api/v1/me');
    vi.stubEnv('API_INTERNAL_URL', 'https://api.example.test:8443/');
    const second = proxy(new NextRequest('http://localhost:3000/api/v1/me'));
    expect(rewriteOf(second)).toBe('https://api.example.test:8443/api/v1/me');
  });

  it('keeps the path and the exact query string, and forwards the health endpoints', () => {
    const query = proxy(
      new NextRequest(
        'http://localhost:3000/api/v1/cases/a%2Fb/timeline?asOf=2025-03-14T09%3A00%3A00Z&q=a%20b',
      ),
    );
    expect(rewriteOf(query)).toBe(
      'http://api.internal:4000/api/v1/cases/a%2Fb/timeline?asOf=2025-03-14T09%3A00%3A00Z&q=a%20b',
    );
    for (const path of ['/livez', '/healthz', '/readyz'])
      expect(rewriteOf(proxy(new NextRequest(`http://localhost:3000${path}`)))).toBe(
        `http://api.internal:4000${path}`,
      );
  });

  it('forwards every method and leaves the request headers and body untouched', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = proxy(
        new NextRequest('http://localhost:3000/api/v1/cases', {
          method,
          headers: {
            'x-request-id': 'req-1',
            'x-correlation-id': 'corr-1',
            'idempotency-key': 'k-1',
          },
          ...(method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
            ? { body: JSON.stringify({ title: 'x' }) }
            : {}),
        }),
      );
      expect(rewriteOf(response), method).toBe('http://api.internal:4000/api/v1/cases');
      // Request headers are only overridden when the proxy sets some; none are set for the API.
      expect(response.headers.get('x-middleware-override-headers'), method).toBeNull();
      expect(
        [...response.headers.keys()].filter((name) => name.startsWith('x-middleware-request-')),
        method,
      ).toEqual([]);
    }
  });

  it('never puts a CSP or nonce on forwarded API responses', () => {
    for (const path of ['/api/v1/me', '/livez', '/readyz']) {
      const response = proxy(new NextRequest(`http://localhost:3000${path}`));
      expect(response.headers.get('content-security-policy'), path).toBeNull();
      expect(response.headers.get('x-middleware-request-x-nonce'), path).toBeNull();
    }
  });

  it('still gives pages the nonce CSP and does not rewrite them', () => {
    const page = proxy(new NextRequest('http://localhost:3000/apiary'));
    expect(page.headers.get('content-security-policy')).toContain("'nonce-");
    expect(rewriteOf(page)).toBeNull();
  });

  it('matches the API paths unconditionally and pages only when they are not prefetches', () => {
    expect(config.matcher.slice(0, 4)).toEqual(['/api/:path*', '/livez', '/healthz', '/readyz']);
    const pages = config.matcher[4];
    expect(pages).toMatchObject({
      missing: [{ key: 'next-router-prefetch' }, { key: 'purpose', value: 'prefetch' }],
    });
  });
});

describe('[API-FWD-02] API_INTERNAL_URL is validated once, and refused clearly in production', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  it('defaults to http://localhost:4000 outside production only', () => {
    expect(resolveApiOrigin(undefined, 'development')).toEqual({
      ok: true,
      origin: DEFAULT_API_ORIGIN,
    });
    expect(resolveApiOrigin('  ', 'test')).toEqual({ ok: true, origin: DEFAULT_API_ORIGIN });
    expect(resolveApiOrigin(undefined, 'production')).toMatchObject({ ok: false });
    expect(resolveApiOrigin('', 'production')).toMatchObject({ ok: false });
  });

  it('accepts an absolute http(s) origin and normalises a trailing slash', () => {
    expect(resolveApiOrigin('http://api:4000', 'production')).toEqual({
      ok: true,
      origin: 'http://api:4000',
    });
    expect(resolveApiOrigin('https://api.example.test/', 'production')).toEqual({
      ok: true,
      origin: 'https://api.example.test',
    });
    expect(resolveApiOrigin('http://api.internal:80', 'production')).toEqual({
      ok: true,
      origin: 'http://api.internal',
    });
  });

  it.each([
    ['not a url'],
    ['ftp://api:4000'],
    ['//api:4000'],
    ['api:4000'],
    ['http://user:secret@api:4000'],
    ['http://api:4000/base'],
    ['http://api:4000/?x=1'],
    ['http://api:4000/#frag'],
  ])('rejects %s without echoing it', (value) => {
    const result = resolveApiOrigin(value, 'production');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain('secret');
  });

  it('answers 502 problem+json (no rewrite, no CSP) when it is missing in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_INTERNAL_URL', '');
    const request = () =>
      new NextRequest('http://localhost:3000/api/v1/me', {
        headers: { 'x-correlation-id': 'corr-42' },
      });
    const response = proxy(request());
    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toBe('application/problem+json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(rewriteOf(response)).toBeNull();
    expect(response.headers.get('content-security-policy')).toBeNull();
    expect(await response.json()).toMatchObject({
      status: 502,
      code: 'upstream_not_configured',
      title: 'The API is not configured',
      correlationId: 'corr-42',
      detail: expect.stringContaining('API_INTERNAL_URL is not set'),
    });
    // The same configuration is validated, and logged, once.
    proxy(request());
    proxy(request());
    expect(vi.mocked(console.error)).toHaveBeenCalledTimes(1);
  });

  it('answers 502 for an invalid value in production and ignores an unsafe correlation id', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_INTERNAL_URL', 'ftp://api:4000');
    const response = proxy(
      new NextRequest('http://localhost:3000/readyz', {
        headers: { 'x-correlation-id': 'bad id<script>' },
      }),
    );
    expect(response.status).toBe(502);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe('upstream_not_configured');
    expect(body).not.toHaveProperty('correlationId');
  });

  it('falls back to the local default for forwarding when not in production', () => {
    vi.stubEnv('API_INTERNAL_URL', '');
    const response = proxy(new NextRequest('http://localhost:3000/api/v1/me'));
    expect(rewriteOf(response)).toBe('http://localhost:4000/api/v1/me');
  });
});
