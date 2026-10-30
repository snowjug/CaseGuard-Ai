import { isIP } from 'node:net';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_IP_HEADER,
  DEFAULT_API_ORIGIN,
  clientAddressFromForwardedFor,
  isForwardedPath,
  isIpLiteral,
  resolveApiOrigin,
} from './lib/api-forward';
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

/**
 * The complete set of request headers Next sends upstream for a rewrite, as the proxy declared it. Next treats
 * `x-middleware-override-headers` as the full list: a request header that is not named in it is removed.
 */
function upstreamHeadersOf(response: Response): Record<string, string> | null {
  const names = response.headers.get('x-middleware-override-headers');
  if (names === null) return null;
  return Object.fromEntries(
    names
      .split(',')
      .map((name) => [name, response.headers.get(`x-middleware-request-${name}`) ?? '']),
  );
}

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

  it('forwards every method with the caller headers and body unchanged', () => {
    const incoming = {
      'x-request-id': 'req-1',
      'x-correlation-id': 'corr-1',
      'idempotency-key': 'k-1',
      authorization: 'Bearer test-token',
      'x-cg-persona': 'persona_engineer',
      cookie: 'cg-persona=persona_engineer',
      'content-type': 'application/json',
    };
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = proxy(
        new NextRequest('http://localhost:3000/api/v1/cases', {
          method,
          headers: incoming,
          ...(method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
            ? { body: JSON.stringify({ title: 'x' }) }
            : {}),
        }),
      );
      expect(rewriteOf(response), method).toBe('http://api.internal:4000/api/v1/cases');
      // Every incoming header is named (an unnamed one would be dropped) with its value unchanged, and with no
      // x-forwarded-for there is no address to add.
      expect(upstreamHeadersOf(response), method).toEqual(incoming);
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

describe('[API-FWD-03] the caller address reaches the API in x-cg-client-ip', () => {
  const url = 'http://localhost:3000/api/v1/me';
  const forward = (headers: HeadersInit): Response => proxy(new NextRequest(url, { headers }));
  const clientIpFor = (headers: HeadersInit): string | undefined =>
    upstreamHeadersOf(forward(headers))?.[CLIENT_IP_HEADER];

  beforeEach(() => {
    vi.stubEnv('API_INTERNAL_URL', 'http://api.internal:4000');
  });

  it('uses the right-most x-forwarded-for entry: the address our own ingress appended', () => {
    expect(clientIpFor({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })).toBe('5.6.7.8');
    expect(clientIpFor({ 'x-forwarded-for': '203.0.113.7' })).toBe('203.0.113.7');
    expect(clientIpFor({ 'x-forwarded-for': '10.0.0.1,10.0.0.2 ,\t198.51.100.9 ' })).toBe(
      '198.51.100.9',
    );
  });

  it('joins repeated x-forwarded-for lines and still takes the last entry', () => {
    const request = new NextRequest(url, {
      headers: [
        ['x-forwarded-for', '1.1.1.1'],
        ['x-forwarded-for', '2.2.2.2, 3.3.3.3'],
      ],
    });
    expect(upstreamHeadersOf(proxy(request))?.[CLIENT_IP_HEADER]).toBe('3.3.3.3');
  });

  it('strips a port and IPv6 brackets', () => {
    expect(clientIpFor({ 'x-forwarded-for': '1.1.1.1, 5.6.7.8:54321' })).toBe('5.6.7.8');
    expect(clientIpFor({ 'x-forwarded-for': '1.1.1.1, [2001:db8::7]:443' })).toBe('2001:db8::7');
    expect(clientIpFor({ 'x-forwarded-for': '[2001:db8::7]' })).toBe('2001:db8::7');
    expect(clientIpFor({ 'x-forwarded-for': '2001:db8::7' })).toBe('2001:db8::7');
    expect(clientIpFor({ 'x-forwarded-for': '::ffff:192.0.2.1' })).toBe('::ffff:192.0.2.1');
  });

  it('removes a x-cg-client-ip sent by the client, in any letter case, and sets our own value', () => {
    // Without an address of our own the client's value is simply gone.
    expect(
      upstreamHeadersOf(forward({ 'X-CG-Client-IP': '9.9.9.9', 'x-request-id': 'r1' })),
    ).toEqual({ 'x-request-id': 'r1' });
    // With one, ours replaces it, and the header is declared exactly once.
    const response = forward({
      'X-Cg-Client-Ip': '9.9.9.9',
      'x-forwarded-for': '9.9.9.9, 5.6.7.8',
    });
    expect(upstreamHeadersOf(response)?.[CLIENT_IP_HEADER]).toBe('5.6.7.8');
    const declared = (response.headers.get('x-middleware-override-headers') ?? '').split(',');
    expect(declared.filter((name) => name === CLIENT_IP_HEADER)).toHaveLength(1);
    // Repeated lines are joined by the Headers API and dropped as one.
    const repeated = new NextRequest(url, {
      headers: [
        ['x-cg-client-ip', '1.1.1.1'],
        ['x-cg-client-ip', '2.2.2.2'],
        ['x-request-id', 'r1'],
      ],
    });
    expect(upstreamHeadersOf(proxy(repeated))).toEqual({ 'x-request-id': 'r1' });
  });

  it('sets nothing, and still drops a client value, when there is no usable address', () => {
    for (const forwardedFor of [undefined, '', ',', 'unknown', '5.6.7.8, unknown', '5.6.7.8,']) {
      const headers: Record<string, string> = { 'x-cg-client-ip': '9.9.9.9', 'x-request-id': 'r1' };
      if (forwardedFor !== undefined) headers['x-forwarded-for'] = forwardedFor;
      const upstream = upstreamHeadersOf(forward(headers));
      expect(upstream, String(forwardedFor)).not.toHaveProperty(CLIENT_IP_HEADER);
      expect(upstream?.['x-request-id'], String(forwardedFor)).toBe('r1');
    }
  });

  it('never falls back to an entry left of the last one, which the client controls', () => {
    expect(clientIpFor({ 'x-forwarded-for': '5.6.7.8, not-an-ip' })).toBeUndefined();
    expect(clientIpFor({ 'x-forwarded-for': '5.6.7.8, [::1' })).toBeUndefined();
    expect(clientIpFor({ 'x-forwarded-for': '5.6.7.8, fe80::1%eth0' })).toBeUndefined();
  });

  it('leaves every other request header exactly as the client sent it', () => {
    const incoming = {
      accept: 'application/json',
      'accept-encoding': 'gzip, br',
      authorization: 'Bearer test-token',
      cookie: 'a=1; b=2',
      'content-type': 'application/json',
      'idempotency-key': 'k-1',
      'x-correlation-id': 'corr-1',
      'x-forwarded-for': '1.2.3.4, 5.6.7.8',
      'x-forwarded-host': 'app.example.test',
      'x-forwarded-proto': 'https',
      'x-request-id': 'req-1',
    };
    expect(upstreamHeadersOf(forward(incoming))).toEqual({
      ...incoming,
      [CLIENT_IP_HEADER]: '5.6.7.8',
    });
  });

  it('applies to the health endpoints too, and never to page requests', () => {
    const headers = { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' };
    const ready = proxy(new NextRequest('http://localhost:3000/readyz', { headers }));
    expect(upstreamHeadersOf(ready)?.[CLIENT_IP_HEADER]).toBe('5.6.7.8');
    const page = proxy(new NextRequest('http://localhost:3000/', { headers }));
    expect(page.headers.get(`x-middleware-request-${CLIENT_IP_HEADER}`)).toBeNull();
  });

  it('forwards nothing at all while the API is not configured', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_INTERNAL_URL', '');
    const response = forward({ 'x-cg-client-ip': '9.9.9.9', 'x-forwarded-for': '5.6.7.8' });
    expect(response.status).toBe(502);
    expect(upstreamHeadersOf(response)).toBeNull();
    expect(response.headers.get(`x-middleware-request-${CLIENT_IP_HEADER}`)).toBeNull();
  });
});

describe('[API-FWD-04] only a literal IPv4 or IPv6 address is believed', () => {
  it.each([
    ['1.2.3.4', '1.2.3.4'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['1.2.3.4:5678', '1.2.3.4'],
    ['1.2.3.4:65535', '1.2.3.4'],
    ['  1.2.3.4  ', '1.2.3.4'],
    ['::1', '::1'],
    ['::', '::'],
    ['2001:db8::1', '2001:db8::1'],
    ['2001:DB8::1', '2001:DB8::1'],
    ['fe80::1', 'fe80::1'],
    ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:1.2.3.4'],
    // Without brackets the last group is part of the address, never a port.
    ['2001:db8::1:8080', '2001:db8::1:8080'],
    ['[::1]', '::1'],
    ['[2001:db8::1]:443', '2001:db8::1'],
    ['[2001:db8::1]:65535', '2001:db8::1'],
    ['[::ffff:1.2.3.4]:80', '::ffff:1.2.3.4'],
  ])('accepts %j as %j', (entry, expected) => {
    expect(clientAddressFromForwardedFor(entry)).toBe(expected);
    expect(clientAddressFromForwardedFor(`9.9.9.9, ${entry}`)).toBe(expected);
  });

  it.each([
    '',
    ' ',
    ',',
    'unknown',
    '_hidden',
    'localhost',
    'example.com',
    '1.2.3',
    '1.2.3.4.5',
    '256.1.1.1',
    '1.2.3.256',
    '01.2.3.4',
    '1.2.3.04',
    '1.2.-3.4',
    '0x7f.0.0.1',
    '2130706433',
    '127.1',
    '1.2.3.4/32',
    '1.2.3.4;x',
    'for=1.2.3.4',
    '"1.2.3.4"',
    '1.2.3.4 5.6.7.8',
    '1.2.3.4:',
    '1.2.3.4:0x50',
    '1.2.3.4:65536',
    '1.2.3.4:99999',
    '1.2.3.4:123456',
    '1.2.3.4:80:90',
    '1.2.3.4 :80',
    ':80',
    'fe80::1%eth0',
    '[fe80::1%eth0]',
    '[fe80::1%25eth0]:80',
    '[1.2.3.4]',
    '[1.2.3.4]:80',
    '[::1',
    '::1]',
    '[::1]x',
    '[::1]:',
    '[::1]:99999',
    '[::1] :80',
    '[]',
    '[[::1]]',
    '[::1]:80:90',
    ':::',
    '1::2::3',
    '12345::1',
    '1:2:3:4:5:6:7:8:9',
    '1:2:3:4:5:6:7:8::',
    '1::2:3:4:5:6:7:8',
    'g::1',
    '::1.2.3',
    '::ffff:01.2.3.4',
  ])('refuses %j', (entry) => {
    expect(clientAddressFromForwardedFor(entry)).toBeNull();
    expect(clientAddressFromForwardedFor(`9.9.9.9, ${entry}`)).toBeNull();
    expect(isIpLiteral(entry)).toBe(false);
  });

  it('is stricter than net.isIP, which also accepts an IPv6 zone id (free text, so unlimited keys)', () => {
    expect(isIP('fe80::1%eth0')).toBe(6);
    expect(isIpLiteral('fe80::1%eth0')).toBe(false);
    expect(isIpLiteral('fe80::1')).toBe(true);
    expect(isIpLiteral('1.2.3.4')).toBe(true);
  });

  it('reads only the last entry, so a huge header costs next to nothing', () => {
    expect(clientAddressFromForwardedFor(`${'1.1.1.1, '.repeat(2000)}9.9.9.9`)).toBe('9.9.9.9');
    expect(clientAddressFromForwardedFor(' '.repeat(100_000))).toBeNull();
    expect(clientAddressFromForwardedFor(`1.1.1.1,${'f'.repeat(100_000)}`)).toBeNull();
    expect(clientAddressFromForwardedFor(null)).toBeNull();
    expect(clientAddressFromForwardedFor(undefined)).toBeNull();
  });
});
