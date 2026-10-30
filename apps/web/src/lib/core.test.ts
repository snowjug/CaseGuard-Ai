import { describe, expect, it } from 'vitest';
import { buildCsp, entraOrigin, generateNonce } from './csp';
import { readPublicEnv } from './env';
import { buildBreadcrumbs, caseIdFromPath, navContext, NAV_ITEMS } from './nav';
import { safeInternalHref } from './safe-href';
import { CASE_COOKIE, parseCaseId, readCaseCookie, serializeCaseCookie } from './case-cookie';
import { caseHref, evidenceLinkHref, evidenceLinkLabel } from './deep-links';

describe('[SEC-CSP-01] Content-Security-Policy', () => {
  const policy = buildCsp({ nonce: 'abc123', isDevelopment: false });
  const directive = (name: string): string =>
    policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';

  it('allows scripts only with the per-request nonce and strict-dynamic, never inline or eval', () => {
    expect(directive('script-src')).toContain("'nonce-abc123'");
    expect(directive('script-src')).toContain("'strict-dynamic'");
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
  });

  it('keeps styles inline-capable (Fluent injects them) and forbids framing, plugins and foreign form posts', () => {
    expect(directive('style-src')).toContain("'unsafe-inline'");
    expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
    expect(directive('form-action')).toBe("form-action 'self'");
  });

  it('limits connections to the same origin, plus the Entra authority when configured', () => {
    expect(directive('connect-src')).toBe("connect-src 'self'");
    const withEntra = buildCsp({
      nonce: 'n',
      isDevelopment: false,
      entraAuthority: 'https://login.microsoftonline.com/tenant-id/v2.0',
    });
    expect(withEntra).toContain('connect-src');
    expect(withEntra).toContain('https://login.microsoftonline.com');
  });

  it('only loosens script rules in development (React needs eval for debugging)', () => {
    expect(buildCsp({ nonce: 'n', isDevelopment: true })).toContain("'unsafe-eval'");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(policy).toContain('upgrade-insecure-requests');
  });

  it('can leave out upgrade-insecure-requests, which would blank a page served over plain http', () => {
    const plain = buildCsp({ nonce: 'n', isDevelopment: false, upgradeInsecureRequests: false });
    expect(plain).not.toContain('upgrade-insecure-requests');
    expect(plain).toContain("script-src 'self' 'nonce-n' 'strict-dynamic'");
  });

  it('generates unpredictable base64 nonces', () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9+/=]{16,}$/);
  });

  it('derives the authority origin and ignores anything that is not an https URL', () => {
    expect(entraOrigin('https://login.microsoftonline.com/abc/v2.0')).toBe(
      'https://login.microsoftonline.com',
    );
    expect(entraOrigin('javascript:alert(1)')).toBeNull();
    expect(entraOrigin('not a url')).toBeNull();
    expect(entraOrigin(undefined)).toBeNull();
  });
});

describe('[CFG-ENV-01] public environment', () => {
  it('defaults to the development identity, local environment and strict validation outside production', () => {
    const env = readPublicEnv({ NODE_ENV: 'development' });
    expect(env.authMode).toBe('dev');
    expect(env.appEnv).toBe('local');
    expect(env.validateResponses).toBe('always');
  });

  it('turns response validation off in production unless asked otherwise', () => {
    expect(readPublicEnv({ NODE_ENV: 'production' }).validateResponses).toBe('off');
    expect(
      readPublicEnv({ NODE_ENV: 'production', NEXT_PUBLIC_API_VALIDATION: 'sample' })
        .validateResponses,
    ).toBe('sample');
    expect(
      readPublicEnv({ NODE_ENV: 'production', NEXT_PUBLIC_API_VALIDATION: 'bogus' })
        .validateResponses,
    ).toBe('off');
  });

  it('falls back to dev for an unknown auth mode and trims blanks', () => {
    expect(readPublicEnv({ NEXT_PUBLIC_AUTH_MODE: 'oauth' }).authMode).toBe('dev');
    expect(
      readPublicEnv({ NEXT_PUBLIC_AUTH_MODE: 'entra', NEXT_PUBLIC_ENTRA_CLIENT_ID: '  ' }).entra
        .clientId,
    ).toBeUndefined();
    expect(readPublicEnv({ NEXT_PUBLIC_AUTH_MODE: 'entra' }).authMode).toBe('entra');
  });
});

describe('[UX-NAV-01] navigation model', () => {
  it('has the 12 destinations of the spec with unique shortcut keys', () => {
    expect(NAV_ITEMS).toHaveLength(12);
    const keys = NAV_ITEMS.map((item) => item.shortcutKey);
    expect(new Set(keys).size).toBe(12);
    expect(NAV_ITEMS.map((item) => item.label)).toEqual([
      'Command Center',
      'Cases',
      'Case Timeline',
      'Evidence Ledger',
      'Hypothesis Arena',
      'Counterfactual Lab',
      'Quality Review',
      'SkillDNA Library',
      'Efficiency Monitor',
      'Governance',
      'System Health',
      'Demo Guide',
    ]);
  });

  it('sends case destinations to the case list until a case is known, then to the case', () => {
    const timeline = NAV_ITEMS.find((item) => item.id === 'timeline');
    expect(timeline?.href(navContext('/', null))).toBe('/cases');
    expect(timeline?.href(navContext('/', 'case_9'))).toBe('/cases/case_9/timeline');
    expect(timeline?.href(navContext('/cases/case_1/evidence', 'case_9'))).toBe(
      '/cases/case_1/timeline',
    );
  });

  it('marks the active destination from the path', () => {
    const active = (path: string): string[] =>
      NAV_ITEMS.filter((item) => item.isActive(path)).map((item) => item.id);
    expect(active('/')).toEqual(['command-center']);
    expect(active('/cases')).toEqual(['cases']);
    expect(active('/cases/new')).toEqual(['cases']);
    expect(active('/cases/c1')).toEqual(['cases']);
    expect(active('/cases/c1/timeline')).toEqual(['timeline']);
    expect(active('/cases/c1/quality')).toEqual(['quality']);
    expect(active('/quality')).toEqual(['quality']);
    expect(active('/skills/s1')).toEqual(['skills']);
  });

  it('extracts the case id from a path but never treats the wizard route as a case', () => {
    expect(caseIdFromPath('/cases/case_1/timeline')).toBe('case_1');
    expect(caseIdFromPath('/cases/new')).toBeNull();
    expect(caseIdFromPath('/skills/s1')).toBeNull();
    expect(caseIdFromPath('/cases/a%20b')).toBe('a b');
  });

  it('builds breadcrumbs from the URL, preferring registered labels for ids', () => {
    expect(buildBreadcrumbs('/')).toEqual([{ label: 'Command Center' }]);
    expect(buildBreadcrumbs('/cases/case_1/timeline', { 'case:case_1': 'SAMPLE-001' })).toEqual([
      { label: 'Command Center', href: '/' },
      { label: 'Cases', href: '/cases' },
      { label: 'SAMPLE-001', href: '/cases/case_1' },
      { label: 'Case Timeline' },
    ]);
    expect(buildBreadcrumbs('/skills/skill_1').at(-1)).toEqual({ label: 'skill_1' });
  });
});

describe('[SEC-LINK-01] safe internal hrefs', () => {
  it('accepts same-origin paths only', () => {
    expect(safeInternalHref('/cases/c1?sel=1')).toBe('/cases/c1?sel=1');
    expect(safeInternalHref('//evil.example/x')).toBeNull();
    expect(safeInternalHref('https://evil.example/x')).toBeNull();
    expect(safeInternalHref('javascript:alert(1)')).toBeNull();
    expect(safeInternalHref('/\\evil.example')).toBeNull();
    expect(safeInternalHref('cases')).toBeNull();
  });
});

describe('remembered case cookie', () => {
  it('round-trips a valid id and rejects hostile values', () => {
    expect(readCaseCookie(`a=1; ${CASE_COOKIE}=case_9; b=2`)).toBe('case_9');
    expect(readCaseCookie(`${CASE_COOKIE}=%E0%A4%A`)).toBeNull();
    expect(parseCaseId('../../etc')).toBeNull();
    expect(parseCaseId('case 1')).toBeNull();
    expect(parseCaseId('case_1')).toBe('case_1');
    expect(serializeCaseCookie('case_1')).toContain('SameSite=Lax');
    expect(serializeCaseCookie(null)).toContain('Max-Age=0');
  });
});

describe('deep links', () => {
  it('opens the page that owns an evidence reference with the item selected', () => {
    expect(caseHref('c 1', 'timeline')).toBe('/cases/c%201/timeline');
    expect(evidenceLinkHref('c1', { type: 'event', id: 'evt 9' })).toBe(
      '/cases/c1/timeline?sel=evt%209',
    );
    expect(evidenceLinkHref('c1', { type: 'claim', id: 'cl1' })).toBe('/cases/c1/evidence?sel=cl1');
    expect(evidenceLinkHref('c1', { type: 'hypothesis', id: 'h1' })).toBe(
      '/cases/c1/hypotheses?sel=h1',
    );
    expect(evidenceLinkHref('c1', { type: 'fork', id: 'f1' })).toBe(
      '/cases/c1/counterfactual?sel=f1',
    );
  });

  it('labels a link with the server text or a readable fallback', () => {
    expect(evidenceLinkLabel({ type: 'event', id: 'evt_1', label: ' Second log request ' })).toBe(
      'Second log request',
    );
    expect(evidenceLinkLabel({ type: 'claim', id: 'claim_0123456789abcdef' })).toBe(
      'Claim claim_012345…',
    );
  });
});
