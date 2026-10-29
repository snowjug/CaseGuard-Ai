import { describe, expect, it } from 'vitest';
import {
  createScrubber,
  isSensitiveKey,
  REDACTED,
  sanitizeUrl,
  scrubValue,
  serializeError,
} from '../src';
import { fakeSecrets } from './helpers/secrets';

describe('field-name classification', () => {
  const sensitive = [
    'password',
    'Password',
    'passwd',
    'userPassword',
    'passwordHash',
    'secret',
    'clientSecret',
    'client_secret',
    'token',
    'accessToken',
    'access_token',
    'id-token',
    'refreshToken',
    'apiKey',
    'api_key',
    'x-api-key',
    'X-API-KEY',
    'authorization',
    'Authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'Set-Cookie',
    'connectionString',
    'connection_string',
    'privateKey',
    'accountKey',
    'sharedAccessKey',
    'subscriptionKey',
    'ocp-apim-subscription-key',
    'sessionId',
    'csrfToken',
    'xsrf-token',
    'signature',
    'sig',
    'sas',
    'jwt',
    'dsn',
    'otp',
    'pin',
    'email',
    'userEmail',
    'emailAddress',
    'phone',
    'phoneNumber',
    'firstName',
    'lastName',
    'fullName',
    'displayName',
    'dob',
    'ssn',
    'userSsn',
    'creditCard',
    'cardNumber',
    'cvv',
    'iban',
    'address',
    'username',
    'transcript',
    'caseContent',
    'systemPrompt',
    'userPrompt',
    'completion',
    'completionText',
  ];
  const harmless = [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'cachedTokens',
    'maxTokens',
    'tokenCount',
    'tokensIn',
    'tenantId',
    'userId',
    'requestId',
    'caseId',
    'route',
    'method',
    'statusCode',
    'durationMs',
    'idempotencyKey',
    'cacheKey',
    'partitionKey',
    'primaryKey',
    'prevHash',
    'templateHash',
    'version',
    'service',
    'env',
    'commit',
    'agent',
    'model',
    'provider',
    'status',
    'ipAddress',
    'remoteAddress',
    'authMode',
    'authFailures',
    'promptVersion',
    'classname',
    'pinned',
  ];

  it.each(sensitive.map((key) => [key] as const))('[NFR-SEC-06] %s is sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(harmless.map((key) => [key] as const))('[NFR-OBS-01] %s is not sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('scrubValue', () => {
  it('[NFR-SEC-06] redacts credential keys at any depth, in arrays, regardless of case', () => {
    const output = scrubValue({
      a: { b: { c: { d: { e: { Password: 'fakeHunter2Value', keep: 1 } } } } },
      list: [{ API_KEY: 'fake-api-key-0123456789abcdef' }, { ok: true }],
      headers: {
        Authorization: 'Bearer fakeBearerToken0123456789abcdef',
        Cookie: 'sid=fakeSessionCookie0123456789',
        'Set-Cookie': ['sid=fakeSessionCookie0123456789; HttpOnly'],
        'X-Api-Key': 'fake-api-key-0123456789abcdef',
        accept: 'application/json',
      },
    });
    const text = JSON.stringify(output);
    for (const leaked of [
      'fakeHunter2Value',
      'fake-api-key',
      'fakeBearerToken',
      'fakeSessionCookie',
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain('application/json');
    expect(text).toContain('"keep":1');
  });

  it('[NFR-OBS-01] keeps counters and flags that merely share a word with a credential', () => {
    expect(
      scrubValue({
        promptTokens: 12,
        completionTokens: 7,
        passwordRequired: true,
        hasToken: false,
        token: null,
        emailCount: 3,
      }),
    ).toEqual({
      promptTokens: 12,
      completionTokens: 7,
      passwordRequired: true,
      hasToken: false,
      token: null,
      emailCount: 3,
    });
  });

  it('[NFR-SEC-06] redacts numbers under credential keys and objects under PII keys', () => {
    expect(scrubValue({ password: 123456, email: { primary: 'x' }, displayName: 'Ava' })).toEqual({
      password: REDACTED,
      email: REDACTED,
      displayName: REDACTED,
    });
  });

  it('[NFR-SEC-06] redacts the value that follows a credential header name in flat header lists', () => {
    expect(
      scrubValue([
        'Host',
        'localhost',
        'Authorization',
        'Bearer fakeBearerToken0123456789abcdef',
        'Accept',
        '*/*',
      ]),
    ).toEqual(['Host', 'localhost', 'Authorization', REDACTED, 'Accept', '*/*']);
    expect(scrubValue([['cookie', 'fakeSessionCookie0123456789']])).toEqual([['cookie', REDACTED]]);
  });

  it('[NFR-SEC-06] scrubs string values and string keys', () => {
    const [secret] = fakeSecrets();
    const output = JSON.stringify(
      scrubValue({ message: secret?.text, [`key ${secret?.text ?? ''}`]: 'value' }),
    );
    for (const core of secret?.cores ?? []) expect(output).not.toContain(core);
  });

  it('[NFR-OBS-01] converts Map, Set, Headers, URL, Date, RegExp, binary and primitives to JSON-safe data', () => {
    const output = scrubValue({
      map: new Map<unknown, unknown>([
        ['password', 'fakeHunter2Value'],
        ['ok', 1],
      ]),
      set: new Set([1, 2]),
      headers: new Headers({
        authorization: 'Bearer fakeBearerToken0123456789abcdef',
        accept: 'text/plain',
      }),
      url: new URL('https://u:fakeP4ss@example.test/path?sig=fakeSignature123&page=2#frag'),
      date: new Date('2026-01-02T03:04:05.000Z'),
      invalidDate: new Date('nope'),
      regex: /a+b/gi,
      buffer: Buffer.from('fake bytes'),
      bytes: new Uint8Array(4),
      big: 12345678901234567890n,
      symbol: Symbol('s'),
      fn: () => 1,
      undef: undefined,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
    });
    const text = JSON.stringify(output);
    expect(text).not.toContain('fakeHunter2Value');
    expect(text).not.toContain('fakeBearerToken');
    expect(text).not.toContain('fakeP4ss');
    expect(text).not.toContain('fakeSignature123');
    expect(output).toMatchObject({
      set: [1, 2],
      date: '2026-01-02T03:04:05.000Z',
      invalidDate: 'Invalid Date',
      regex: '/a+b/gi',
      buffer: '[Binary 10 bytes]',
      bytes: '[Binary 4 bytes]',
      big: '12345678901234567890',
      nan: 'NaN',
      inf: 'Infinity',
    });
    expect(output).not.toHaveProperty('fn');
    expect(output).not.toHaveProperty('undef');
  });

  it('[NFR-OBS-01] returns plain objects so pino can serialise them', () => {
    const output = scrubValue({ a: { b: 1 } }) as Record<string, unknown>;
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
    expect(typeof output.hasOwnProperty).toBe('function');
  });

  it('[NFR-SEC-06] keeps a `__proto__` key as data without touching any prototype', () => {
    const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true},"safe":1}');
    const output = scrubValue(hostile) as Record<string, unknown>;
    expect(Object.keys(output)).toEqual(expect.arrayContaining(['__proto__', 'safe']));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(output)).toBe(Object.prototype);
  });

  it('[NFR-OBS-01] survives cycles, shared references, throwing getters, throwing toJSON and hostile proxies', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const shared = { n: 1 };
    const throwing = {
      get boom(): string {
        throw new Error('getter exploded');
      },
      fine: 'ok',
    };
    const badJson = {
      toJSON(): unknown {
        throw new Error('toJSON exploded');
      },
    };
    const proxy = new Proxy(
      {},
      {
        ownKeys(): never {
          throw new Error('ownKeys exploded');
        },
      },
    );
    const output = scrubValue({ cyclic, a: shared, b: shared, throwing, badJson, proxy }) as Record<
      string,
      unknown
    >;
    expect(output.cyclic).toEqual({ name: 'loop', self: '[Circular]' });
    expect(output.a).toEqual({ n: 1 });
    expect(output.b).toEqual({ n: 1 });
    expect(output.throwing).toEqual({ boom: '[Unreadable]', fine: 'ok' });
    expect(output.badJson).toBe('[Unserializable]');
    expect(output.proxy).toEqual({});
  });

  it('[NFR-OBS-01] reports hostile objects through onError instead of throwing', () => {
    const errors: unknown[] = [];
    const scrubber = createScrubber({ onError: (error) => errors.push(error) });
    scrubber.value({
      get boom(): string {
        throw new Error('getter exploded');
      },
    });
    expect(errors).toHaveLength(1);
  });

  it('[NFR-OBS-01] bounds depth, array length, key count and node count', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 50; i += 1) deep = { next: deep };
    expect(JSON.stringify(scrubValue(deep))).toContain('[Truncated]');

    const scrubber = createScrubber({ maxArrayLength: 3, maxKeys: 2, maxNodes: 20 });
    expect(scrubber.value([1, 2, 3, 4, 5])).toEqual([1, 2, 3, '[2 more items]']);
    expect(scrubber.value({ a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, '…': '[1 more keys]' });
    const wide = scrubber.value(
      Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => ({ x: {} }))),
    );
    expect(JSON.stringify(wide)).toContain('[Truncated]');
  });

  it('[NFR-OBS-01] caps the total string content scrubbed per call so huge payloads stay cheap', () => {
    const scrubber = createScrubber({ maxTotalChars: 100 });
    expect(scrubber.value(['a'.repeat(60), 'b'.repeat(60), 'c'])).toEqual([
      'a'.repeat(60),
      '[Truncated]',
      '[Truncated]',
    ]);
    const huge = createScrubber().value(Array.from({ length: 100 }, () => 'x'.repeat(30_000)));
    expect(JSON.stringify(huge)).toContain('[Truncated]');
  });

  it('[NFR-SEC-06] honours extra sensitive keys', () => {
    const scrubber = createScrubber({ extraSensitiveKeys: ['internalTicketRef'] });
    expect(scrubber.value({ internal_ticket_ref: 'TCK-1', other: 'x' })).toEqual({
      internal_ticket_ref: REDACTED,
      other: 'x',
    });
  });
});

describe('error serialisation', () => {
  class DependencyError extends Error {
    code = 'ECONNREFUSED';
    status = 503;
    config = { headers: { authorization: 'Bearer fakeBearerToken0123456789abcdef' }, url: '/x' };
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'DependencyError';
    }
  }

  it('[NFR-OBS-01] includes type, message, stack, code, status and the cause chain', () => {
    const error = new DependencyError('database down', { cause: new TypeError('socket closed') });
    const out = serializeError(error);
    expect(out).toMatchObject({
      type: 'DependencyError',
      message: 'database down',
      code: 'ECONNREFUSED',
      status: 503,
      cause: { type: 'TypeError', message: 'socket closed' },
    });
    expect(out.stack).toContain('DependencyError');
  });

  it('[NFR-SEC-06] omits the stack when stacks are disabled (production)', () => {
    const out = createScrubber({ includeStack: false }).error(new Error('boom'));
    expect(out).not.toHaveProperty('stack');
    expect(out.message).toBe('boom');
  });

  it('[NFR-SEC-06] removes secrets from message, stack, props and every cause', () => {
    const [bearer, , jwt, , sql, pg] = fakeSecrets();
    const root = new Error(`root cause: ${pg?.text ?? ''}`);
    root.stack = `Error: root\n    at connect (${sql?.text ?? ''})`;
    const error = new DependencyError(`failed with ${jwt?.text ?? ''}`, { cause: root });
    const out = JSON.stringify(serializeError(error));
    for (const secret of [bearer, jwt, sql, pg]) {
      for (const core of secret?.cores ?? []) expect(out).not.toContain(core);
    }
    expect(out).not.toContain('fakeBearerToken');
  });

  it('[NFR-OBS-01] handles AggregateError, cause cycles and unusual thrown values', () => {
    const aggregate = new AggregateError([new Error('one'), new Error('two')], 'many');
    expect(serializeError(aggregate).errors).toHaveLength(2);

    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(JSON.stringify(serializeError(a))).toContain('[Circular]');

    expect(serializeError('plain string failure password=fakeHunter2Value')).toEqual({
      type: 'NonError',
      message: `plain string failure password=${REDACTED}`,
    });
    expect(serializeError({ code: 7, token: 'fakeTokenValue12345' }).message).not.toContain(
      'fakeTokenValue12345',
    );
    expect(serializeError(undefined).type).toBe('NonError');
    expect(serializeError(null).type).toBe('NonError');
  });

  it('[NFR-OBS-01] never trusts a forged error name or a throwing message getter', () => {
    const forged = new Error('x');
    forged.name = 'Bad Name <script>alert(1)</script>';
    expect(serializeError(forged).type).toBe('Error');

    const hostile = new Error('y');
    Object.defineProperty(hostile, 'message', {
      get(): string {
        throw new Error('message exploded');
      },
    });
    expect(serializeError(hostile).message).toBe('[Unreadable]');
  });
});

describe('sanitizeUrl', () => {
  it.each([
    ['/api/v1/cases?limit=10&sig=fakeSig123456', '/api/v1/cases?limit=10&sig=[REDACTED]'],
    ['/path?access_token=fakeAccessToken123&page=2', '/path?access_token=[REDACTED]&page=2'],
    ['https://user:fakeP4ss@example.test/a/b?x=1#frag', 'https://example.test/a/b?x=1'],
    ['/plain', '/plain'],
    ['/q?client_secret=fakeClientSecret', '/q?client_secret=[REDACTED]'],
  ])('[NFR-SEC-06] %s', (input, expected) => {
    expect(sanitizeUrl(input)).toBe(expected);
  });

  it('[NFR-SEC-06] scrubs secrets hidden in path segments and parameter values', () => {
    const out = sanitizeUrl('/hooks/fake.person@example.test/run?next=https://u:fakeP4ss@h/x');
    expect(out).not.toContain('fake.person@example.test');
    expect(out).not.toContain('fakeP4ss');
  });

  it('[NFR-OBS-01] never throws on garbage and bounds the length', () => {
    for (const input of [
      '',
      ':::',
      'http://',
      'http://[::1',
      '\u0000\u0001',
      'x'.repeat(10_000),
      'mailto:fake@example.test',
    ]) {
      expect(() => sanitizeUrl(input)).not.toThrow();
    }
    expect(sanitizeUrl('/a?b=' + 'x'.repeat(10_000)).length).toBeLessThan(4200);
    expect(sanitizeUrl('mailto:fake.person@example.test')).not.toContain(
      'fake.person@example.test',
    );
  });
});
