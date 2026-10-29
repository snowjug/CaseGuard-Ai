import { describe, expect, it } from 'vitest';
import {
  API_CONTENT_SECURITY_POLICY,
  HSTS_HEADERS,
  SECURITY_HEADERS,
  buildContentSecurityPolicy,
  buildSecurityHeaders,
} from '../src/headers';

const NONCE = 'dGVzdC1ub25jZS12YWx1ZQ==';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name = '', ...sources] = part.split(' ');
      return [name, sources] as const;
    }),
  );
}

describe('buildContentSecurityPolicy', () => {
  it('[NFR-SEC-04] ships a locked-down production policy', () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: NONCE }));
    expect(policy.get('default-src')).toEqual(["'self'"]);
    expect(policy.get('script-src')).toEqual(["'self'", `'nonce-${NONCE}'`, "'strict-dynamic'"]);
    expect(policy.get('style-src')).toEqual(["'self'", "'unsafe-inline'"]);
    expect(policy.get('img-src')).toEqual(["'self'", 'data:']);
    expect(policy.get('connect-src')).toEqual(["'self'"]);
    expect(policy.get('frame-ancestors')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'self'"]);
    expect(policy.get('form-action')).toEqual(["'self'"]);
    expect(policy.get('object-src')).toEqual(["'none'"]);
  });

  it('[NFR-SEC-04] never allows eval or inline scripts in production', () => {
    const text = buildContentSecurityPolicy({
      nonce: NONCE,
      connectSrc: ['https://login.microsoftonline.com'],
    });
    expect(text).not.toContain('unsafe-eval');
    expect(directives(text).get('script-src')).not.toContain("'unsafe-inline'");
  });

  it('allows unsafe-eval and websockets only in development', () => {
    const dev = directives(buildContentSecurityPolicy({ nonce: NONCE, isDev: true }));
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    expect(dev.get('connect-src')).toEqual(expect.arrayContaining(['ws:', 'wss:']));
    const prod = directives(buildContentSecurityPolicy({ nonce: NONCE, isDev: false }));
    expect(prod.get('script-src')).not.toContain("'unsafe-eval'");
    expect(prod.get('connect-src')).not.toContain('ws:');
  });

  it('falls back to a plain self policy for scripts when no nonce is supplied', () => {
    expect(directives(buildContentSecurityPolicy()).get('script-src')).toEqual(["'self'"]);
  });

  it('appends validated connect-src origins', () => {
    const policy = directives(
      buildContentSecurityPolicy({
        connectSrc: [
          'https://login.microsoftonline.com',
          'https://*.example.com:8443',
          'wss://live.example.com',
        ],
      }),
    );
    expect(policy.get('connect-src')).toEqual([
      "'self'",
      'https://login.microsoftonline.com',
      'https://*.example.com:8443',
      'wss://live.example.com',
    ]);
  });

  it('[NFR-SEC-04] rejects values that could inject directives or keywords', () => {
    for (const bad of [
      "'self'; script-src *",
      'https://a.example.com; script-src *',
      "https://a.example.com 'unsafe-inline'",
      'https://a.example.com/path',
      'javascript:alert(1)',
      '*',
      'https://a.example.com\r\nX-Evil: 1',
      '',
    ]) {
      expect(() => buildContentSecurityPolicy({ connectSrc: [bad] }), bad).toThrow(TypeError);
    }
    for (const bad of [
      "abc'; script-src *",
      'short',
      'has space in nonce 1234567',
      `${NONCE}\n`,
      'a'.repeat(200),
    ]) {
      expect(() => buildContentSecurityPolicy({ nonce: bad }), bad).toThrow(TypeError);
    }
  });
});

describe('security header constants', () => {
  it('[NFR-SEC-04] carries the baseline hardening headers', () => {
    expect(SECURITY_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(SECURITY_HEADERS['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['Cross-Origin-Opener-Policy']).toBe('same-origin');
    expect(SECURITY_HEADERS['X-Frame-Options']).toBe('DENY');
    const permissions = SECURITY_HEADERS['Permissions-Policy'] ?? '';
    for (const feature of ['camera', 'microphone', 'geolocation']) {
      expect(permissions).toContain(`${feature}=()`);
    }
  });

  it('keeps HSTS out of the always-on set and only adds it over HTTPS', () => {
    expect(SECURITY_HEADERS).not.toHaveProperty('Strict-Transport-Security');
    expect(HSTS_HEADERS['Strict-Transport-Security']).toMatch(/^max-age=\d+; includeSubDomains$/);
    expect(buildSecurityHeaders({ secureTransport: false })).not.toHaveProperty(
      'Strict-Transport-Security',
    );
    expect(buildSecurityHeaders({ secureTransport: true })).toHaveProperty(
      'Strict-Transport-Security',
    );
  });

  it('is immutable and gives API responses a deny-all policy', () => {
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
    expect(Object.isFrozen(HSTS_HEADERS)).toBe(true);
    expect(API_CONTENT_SECURITY_POLICY).toContain("default-src 'none'");
    expect(API_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });
});
