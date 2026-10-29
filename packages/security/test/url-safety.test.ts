import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { UnsafeUrlError, type UnsafeUrlReason } from '../src/errors';
import {
  assertSafeOutboundUrl,
  isPrivateOrLoopbackHost,
  safeRelativeRedirect,
} from '../src/url-safety';

const OPTIONS = {
  allowedHosts: ['api.contoso.example', '*.openai.azure.com', '*.blob.core.windows.net'],
};

function reasonOf(url: string, options = OPTIONS): UnsafeUrlReason {
  try {
    assertSafeOutboundUrl(url, options);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as UnsafeUrlError).status).toBe(422);
    expect((error as UnsafeUrlError).code).toBe('unsafe_content');
    return (error as UnsafeUrlError).reason;
  }
  return expect.unreachable(`expected ${url} to be rejected`);
}

describe('assertSafeOutboundUrl: what is allowed [NFR-SEC-04]', () => {
  it('accepts https URLs on exact and wildcard allowlist entries and returns the parsed URL', () => {
    const url = assertSafeOutboundUrl('https://api.contoso.example/v1/chat?x=1#f', OPTIONS);
    expect(url).toBeInstanceOf(URL);
    expect(url.hostname).toBe('api.contoso.example');
    expect(
      assertSafeOutboundUrl('https://contoso-ai.openai.azure.com/openai/deployments/x', OPTIONS)
        .hostname,
    ).toBe('contoso-ai.openai.azure.com');
    expect(
      assertSafeOutboundUrl('https://acct.blob.core.windows.net/cases/a.json', OPTIONS).hostname,
    ).toBe('acct.blob.core.windows.net');
  });

  it('normalises case, an explicit default port and a trailing dot', () => {
    expect(assertSafeOutboundUrl('HTTPS://API.Contoso.Example:443/x', OPTIONS).href).toBe(
      'https://api.contoso.example/x',
    );
    expect(assertSafeOutboundUrl('https://api.contoso.example./x', OPTIONS).hostname).toBe(
      'api.contoso.example.',
    );
  });

  it('accepts a URL object', () => {
    expect(assertSafeOutboundUrl(new URL('https://api.contoso.example/x'), OPTIONS).pathname).toBe(
      '/x',
    );
  });

  it('allows extra ports and http only when explicitly enabled', () => {
    expect(
      assertSafeOutboundUrl('https://api.contoso.example:8443/x', {
        ...OPTIONS,
        allowedPorts: [8443],
      }).port,
    ).toBe('8443');
    expect(
      assertSafeOutboundUrl('http://api.contoso.example/x', { ...OPTIONS, allowHttp: true })
        .protocol,
    ).toBe('http:');
    expect(
      assertSafeOutboundUrl('http://api.contoso.example:80/x', { ...OPTIONS, allowHttp: true })
        .port,
    ).toBe('');
  });
});

describe('assertSafeOutboundUrl: what is refused [NFR-SEC-04]', () => {
  it('requires https', () => {
    expect(reasonOf('http://api.contoso.example/x')).toBe('protocol_not_allowed');
    for (const url of [
      'ftp://api.contoso.example/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'gopher://api.contoso.example',
      'data:text/plain,hi',
      'ws://api.contoso.example',
    ]) {
      expect(['protocol_not_allowed', 'invalid_url']).toContain(reasonOf(url));
    }
  });

  it('refuses credentials in the URL, including empty and tricky forms', () => {
    for (const url of [
      'https://user:pass@api.contoso.example/x',
      'https://user@api.contoso.example/x',
      'https://@api.contoso.example/x',
      'https://api.contoso.example@evil.example/x',
      'https://:@api.contoso.example/x',
    ]) {
      expect(['credentials_in_url', 'host_not_allowed']).toContain(reasonOf(url));
    }
    expect(reasonOf('https://user:pass@api.contoso.example/x')).toBe('credentials_in_url');
    expect(reasonOf('https://@api.contoso.example/x')).toBe('credentials_in_url');
  });

  it('refuses IP literals in every notation', () => {
    for (const url of [
      'https://1.2.3.4/x',
      'https://8.8.8.8/x',
      'https://[2606:4700:4700::1111]/x',
      'https://[::1]/x',
      'https://[::ffff:8.8.8.8]/x',
      'https://2130706433/x',
      'https://0x7f000001/x',
      'https://0177.0.0.1/x',
      'https://127.1/x',
      'https://0x7f.0.0.1/x',
      'https://3232235777/x',
      'https://1.2.3/x', // shorthand for 1.2.0.3
      'https://169.254.169.254/latest/meta-data/',
    ]) {
      expect(reasonOf(url), url).toBe('ip_literal_host');
    }
  });

  it('refuses localhost, internal names and the metadata hostnames even if they were allowlisted', () => {
    const allowedHosts = [
      'localhost',
      'app.localhost',
      'printer.local',
      'metadata.google.internal',
      'db.corp.internal',
      'intranet.lan',
    ];
    for (const url of [
      'https://localhost/x',
      'https://LOCALHOST:443/x',
      'https://app.localhost/x',
      'https://printer.local/x',
      'https://metadata.google.internal/computeMetadata/v1/',
      'https://db.corp.internal/x',
      'https://intranet.lan/x',
    ]) {
      expect(reasonOf(url, { allowedHosts }), url).toBe('private_or_local_host');
    }
  });

  it('refuses everything not on the allowlist, including look-alikes', () => {
    for (const url of [
      'https://evil.example/x',
      'https://api.contoso.example.evil.example/x',
      'https://evilapi.contoso.example/x',
      'https://contoso.example/x',
      'https://openai.azure.com/x',
      'https://openai.azure.com.evil.example/x',
      'https://xopenai.azure.com/x',
      'https://api-contoso.example/x',
    ]) {
      expect(reasonOf(url), url).toBe('host_not_allowed');
    }
  });

  it('matches wildcards on label boundaries only', () => {
    expect(reasonOf('https://evil-openai.azure.com/x')).toBe('host_not_allowed');
    expect(assertSafeOutboundUrl('https://a.b.openai.azure.com/x', OPTIONS).hostname).toBe(
      'a.b.openai.azure.com',
    );
  });

  it('refuses unexpected ports', () => {
    expect(reasonOf('https://api.contoso.example:8443/x')).toBe('port_not_allowed');
    expect(reasonOf('https://api.contoso.example:80/x')).toBe('port_not_allowed');
    expect(reasonOf('https://api.contoso.example:22/x')).toBe('port_not_allowed');
  });

  it('refuses malformed input before it can confuse the parser', () => {
    for (const url of [
      '',
      'not a url',
      '//api.contoso.example/x',
      '/relative/path',
      'https://',
      'https://api.contoso.example\\@evil.example/x',
      'https://api.contoso.example/x\r\nHost: evil.example',
      'https://api.contoso.\texample/x',
      ' https://api.contoso.example/x',
      'https://api.contoso.example/x ',
      `https://api.contoso.example/${'a'.repeat(3000)}`,
      'https://exa mple.com/',
    ]) {
      expect(reasonOf(url), JSON.stringify(url)).toBe('invalid_url');
    }
  });

  it('fails closed on an empty allowlist and rejects over-broad allowlist entries', () => {
    expect(reasonOf('https://api.contoso.example/x', { allowedHosts: [] })).toBe(
      'host_not_allowed',
    );
    for (const entry of [
      '*',
      '*.com',
      '*.',
      'api.contoso.example/path',
      'http://api.contoso.example',
      'bad host',
      '',
    ]) {
      expect(
        () => assertSafeOutboundUrl('https://api.contoso.example/x', { allowedHosts: [entry] }),
        entry,
      ).toThrow(TypeError);
    }
  });

  it('property: never returns a URL whose host is not covered by the allowlist', () => {
    fc.assert(
      fc.property(
        fc.webUrl({
          validSchemes: ['https', 'http', 'ftp'],
          withFragments: true,
          withQueryParameters: true,
        }),
        (candidate) => {
          try {
            const url = assertSafeOutboundUrl(candidate, OPTIONS);
            return (
              url.protocol === 'https:' &&
              (url.hostname === 'api.contoso.example' ||
                url.hostname.endsWith('.openai.azure.com') ||
                url.hostname.endsWith('.blob.core.windows.net'))
            );
          } catch (error) {
            return error instanceof UnsafeUrlError;
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe('isPrivateOrLoopbackHost [NFR-SEC-04]', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    'x.localhost',
    'host.local',
    'a.internal',
    'x.corp',
    'ip6-localhost',
    '127.0.0.1',
    '127.255.255.254',
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.0.1',
    '169.254.169.254',
    '169.254.0.1',
    '100.64.0.1',
    '100.127.255.255',
    '192.0.0.1',
    '192.0.2.5',
    '198.18.0.1',
    '198.51.100.9',
    '203.0.113.9',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
    '::1',
    '[::1]',
    '::',
    'fe80::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.1.2.3',
    '::ffff:a9fe:a9fe',
    '64:ff9b::7f00:1',
    '2002:7f00:1::1',
    '0:0:0:0:0:0:0:1',
    '2130706433',
    '0x7f000001',
    '0x7f.1',
    '0177.0.0.1',
    '127.1',
    '017700000001',
    '3232235777',
    '256.256.256.256',
    '',
  ])('treats %j as private or local', (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(true);
  });

  it.each([
    'example.com',
    'api.openai.azure.com',
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '11.0.0.1',
    '192.169.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '198.20.0.1',
    '223.255.255.255',
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
    '::ffff:8.8.8.8',
    '1password.com',
    'a1.b2.example.org',
  ])('treats %j as public', (host) => {
    expect(isPrivateOrLoopbackHost(host)).toBe(false);
  });
});

describe('safeRelativeRedirect [NFR-SEC-04]', () => {
  it.each([
    ['/', '/'],
    ['/cases', '/cases'],
    ['/cases/case_1?tab=timeline#evidence', '/cases/case_1?tab=timeline#evidence'],
    ['/a/b/../c', '/a/c'],
    ['/search?q=a%20b&next=%2Fcases', '/search?q=a%20b&next=%2Fcases'],
    ['/@handle', '/@handle'],
    ['/https://not-a-scheme-just-a-path', '/https://not-a-scheme-just-a-path'],
  ])('keeps the same-origin path %j', (path, expected) => {
    expect(safeRelativeRedirect(path)).toBe(expected);
  });

  it.each([
    'https://evil.example/',
    'http://evil.example',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/%2f%2fevil.example',
    '/%2F/evil.example',
    '/%5cevil.example',
    '/%255cevil.example',
    '/%252f%252fevil.example',
    'javascript:alert(1)',
    'data:text/html,hi',
    'evil.example',
    'cases',
    '',
    ' /cases',
    '/\tevil.example',
    '/\r\nSet-Cookie: x=1',
    '/%0d%0aSet-Cookie:%20x=1',
    '/%0a',
    `/${'a'.repeat(3000)}`,
    '/%E0%A4%A',
  ])('falls back for the unsafe target %j', (path) => {
    expect(safeRelativeRedirect(path)).toBe('/');
    expect(safeRelativeRedirect(path, '/home')).toBe('/home');
  });

  it('falls back for non-strings', () => {
    for (const value of [undefined, null, 42, {}, ['/a'], true]) {
      expect(safeRelativeRedirect(value)).toBe('/');
    }
  });

  it('property: the result is always a single-origin relative path', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (candidate) => {
        const result = safeRelativeRedirect(candidate);
        return (
          result.startsWith('/') &&
          !result.startsWith('//') &&
          !result.includes('\\') &&
          !/[\r\n]/.test(result)
        );
      }),
      { numRuns: 500 },
    );
  });
});
