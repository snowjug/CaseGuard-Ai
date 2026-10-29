import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  createPrettyDestination,
  createRequestContext,
  PINO_REDACT_PATHS,
  runWithContext,
  setContextValue,
  type Logger,
  type LoggerOptions,
} from '../src';
import { createCapture, createManualClock, seededBytes } from './helpers/fakes';
import { fakeSecrets, type FakeSecret } from './helpers/secrets';

function build(overrides: Partial<LoggerOptions> = {}) {
  const capture = createCapture();
  const clock = createManualClock(Date.parse('2026-10-29T09:14:14.599Z'));
  const logger = createLogger({
    service: 'caseguard-api',
    version: '1.2.3',
    env: 'staging',
    level: 'trace',
    destination: capture.destination,
    clock: clock.now,
    ...overrides,
  });
  return { logger, capture, clock };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger output shape', () => {
  it('[NFR-OBS-01] writes one JSON object per line with ISO time, level label, base fields and message', () => {
    const { logger, capture } = build({ commit: 'abc1234' });
    logger.info({ route: '/api/v1/cases', statusCode: 200 }, 'request completed');
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]?.endsWith('\n')).toBe(true);
    expect(capture.records()[0]).toEqual({
      level: 'info',
      time: '2026-10-29T09:14:14.599Z',
      service: 'caseguard-api',
      version: '1.2.3',
      env: 'staging',
      commit: 'abc1234',
      route: '/api/v1/cases',
      statusCode: 200,
      msg: 'request completed',
    });
  });

  it('[NFR-OBS-01] omits commit when none is provided and uses the injected clock for every line', () => {
    const { logger, capture, clock } = build();
    logger.info('first');
    clock.advance(1500);
    logger.warn('second');
    const [first, second] = capture.records();
    expect(first).not.toHaveProperty('commit');
    expect(first?.time).toBe('2026-10-29T09:14:14.599Z');
    expect(second?.time).toBe('2026-10-29T09:14:16.099Z');
    expect(second?.level).toBe('warn');
  });

  it('[NFR-OBS-01] filters by level and honours silent', () => {
    const { logger, capture } = build({ level: 'warn' });
    logger.debug('no');
    logger.info('no');
    logger.warn('yes');
    logger.error('yes');
    expect(capture.records().map((record) => record.level)).toEqual(['warn', 'error']);
    const silent = build({ level: 'silent' });
    silent.logger.fatal('nothing');
    expect(silent.capture.lines).toHaveLength(0);
  });

  it('[NFR-OBS-01] rejects an unknown level instead of silently logging at the default', () => {
    expect(() => build({ level: 'verbose' as unknown as LoggerOptions['level'] })).toThrow(
      RangeError,
    );
  });

  it('[NFR-OBS-01] scrubs the base fields and truncates very long messages', () => {
    const { logger, capture } = build({ service: 'svc password=fakeHunter2Value' });
    logger.info('x'.repeat(20_000));
    const [record] = capture.records();
    expect(capture.text()).not.toContain('fakeHunter2Value');
    expect((record?.msg as string).length).toBeLessThanOrEqual(4096);
  });

  it('[NFR-OBS-01] never throws while logging cyclic, hostile or exotic values', () => {
    const { logger, capture } = build();
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => {
      logger.info(cyclic, 'cyclic');
      logger.info(
        {
          get boom(): string {
            throw new Error('getter exploded');
          },
        },
        'getter',
      );
      logger.info({ big: 12345678901234567890n, sym: Symbol('s'), fn: () => 1 }, 'exotic');
      logger.info({ buf: Buffer.from('fake'), date: new Date(Number.NaN) }, 'binary');
    }).not.toThrow();
    expect(capture.records()).toHaveLength(4);
  });

  it('[NFR-OBS-01] writes to stdout by default and never through console', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const logger = createLogger({ service: 's', version: '1', env: 'test', level: 'info' });
    logger.info('hello');
    logger.error(new Error('boom'));
    expect(write).toHaveBeenCalled();
    expect(String(write.mock.calls[0]?.[0])).toContain('"msg":"hello"');
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('correlation fields', () => {
  it('[NFR-OBS-01] adds requestId, traceId, spanId, tenantId and userId from the async context', async () => {
    const { logger, capture } = build();
    const context = createRequestContext({
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      generateRequestId: () => 'req_fixed_0001',
      randomBytes: seededBytes(1),
    });
    await runWithContext({ ...context, tenantId: 'tenant_contoso_support' }, async () => {
      setContextValue('userId', 'user_ava_engineer');
      await Promise.resolve();
      logger.info('inside');
    });
    logger.info('outside');
    const [inside, outside] = capture.records();
    expect(inside).toMatchObject({
      requestId: 'req_fixed_0001',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      tenantId: 'tenant_contoso_support',
      userId: 'user_ava_engineer',
    });
    expect(inside?.spanId).toMatch(/^[0-9a-f]{16}$/);
    for (const key of ['requestId', 'traceId', 'spanId', 'tenantId', 'userId']) {
      expect(outside).not.toHaveProperty(key);
    }
  });

  it('[NFR-OBS-01] lets explicit log fields win over context fields', () => {
    const { logger, capture } = build();
    runWithContext({ requestId: 'req_context_01' }, () => {
      logger.info({ requestId: 'req_explicit_01' }, 'explicit');
    });
    expect(capture.records()[0]?.requestId).toBe('req_explicit_01');
  });
});

describe('error serialisation in logs', () => {
  class UpstreamError extends Error {
    code = 'ETIMEDOUT';
    constructor(message: string, options?: ErrorOptions) {
      super(message, options);
      this.name = 'UpstreamError';
    }
  }

  it('[NFR-OBS-01] logs type, message, stack, code and the cause chain outside production', () => {
    const { logger, capture } = build();
    logger.error(new UpstreamError('search timed out', { cause: new Error('socket hang up') }));
    const [record] = capture.records();
    expect(record?.msg).toBe('search timed out');
    expect(record?.err).toMatchObject({
      type: 'UpstreamError',
      message: 'search timed out',
      code: 'ETIMEDOUT',
      cause: { type: 'Error', message: 'socket hang up' },
    });
    expect((record?.err as { stack?: string }).stack).toContain('UpstreamError');
  });

  it('[NFR-SEC-06] omits every stack, including those of causes, in production', () => {
    const { logger, capture } = build({ env: 'production' });
    logger.error({ err: new UpstreamError('down', { cause: new Error('inner') }) }, 'failed');
    expect(capture.text()).not.toContain('"stack"');
    expect(capture.text()).not.toMatch(/\n\s+at /);
    expect(capture.records()[0]?.err).toMatchObject({
      type: 'UpstreamError',
      cause: { message: 'inner' },
    });
  });

  it('[NFR-OBS-01] accepts a bare error, an { err } object and a non-Error thrown value', () => {
    const { logger, capture } = build({ env: 'production' });
    logger.error(new Error('bare'));
    logger.error({ err: new Error('wrapped') }, 'with message');
    logger.error({ err: 'string failure password=fakeHunter2Value' }, 'non error');
    const records = capture.records();
    expect(records[0]).toMatchObject({ msg: 'bare', err: { message: 'bare' } });
    expect(records[1]).toMatchObject({ msg: 'with message', err: { message: 'wrapped' } });
    expect(capture.text()).not.toContain('fakeHunter2Value');
  });
});

const carriers: Record<string, (logger: Logger, secret: FakeSecret) => void> = {
  'message text': (l, s) => l.info(`failed: ${s.text}`),
  'printf argument': (l, s) => l.info('failed: %s', s.text),
  'printf json object': (l, s) => l.info('payload %j', { note: s.text }),
  'object value': (l, s) => l.info({ detail: s.text }, 'object'),
  'nested object and array': (l, s) => l.info({ a: { b: [{ c: s.text }] } }, 'nested'),
  'array of strings': (l, s) => l.info({ list: ['x', s.text] }, 'array'),
  'map and set': (l, s) =>
    l.info({ map: new Map([['k', s.text]]), set: new Set([s.text]) }, 'collections'),
  'embedded json string': (l, s) => l.info({ body: JSON.stringify({ note: s.text }) }, 'json'),
  'message inside object': (l, s) => l.info({ msg: s.text }),
  'credential-named headers': (l, s) =>
    l.info(
      {
        headers: {
          authorization: s.text,
          cookie: s.text,
          'set-cookie': [s.text],
          'x-api-key': s.text,
          'x-custom': s.text,
        },
      },
      'headers',
    ),
  'error message': (l, s) => l.error(new Error(`boom ${s.text}`)),
  'error stack': (l, s) => {
    const error = new Error('x');
    error.stack = `Error: x\n    at fn (${s.text})`;
    l.error({ err: error }, 'stack');
  },
  'error cause chain': (l, s) =>
    l.error(new Error('outer', { cause: new Error('middle', { cause: new Error(s.text) }) })),
  'error props': (l, s) =>
    l.error(
      {
        err: Object.assign(new Error('x'), {
          config: { url: s.text, headers: { authorization: s.text } },
        }),
      },
      'props',
    ),
  'child bindings': (l, s) => l.child({ upstream: s.text, apiKey: s.text }).info('child'),
  'grandchild bindings': (l, s) => l.child({ a: 1 }).child({ upstream: s.text }).info('grandchild'),
};

describe('redaction through the logger', () => {
  const cases = fakeSecrets().flatMap((secret) =>
    Object.keys(carriers).map((carrier) => [secret.id, carrier, secret] as const),
  );

  it.each(cases)(
    '[NFR-OBS-01] [NFR-SEC-06] %s via %s never reaches the output',
    (_id, carrier, secret) => {
      const { logger, capture } = build();
      const emit = carriers[carrier];
      expect(emit).toBeDefined();
      emit?.(logger, secret);
      expect(capture.lines.length).toBeGreaterThan(0);
      const records = capture.records();
      expect(records.length).toBeGreaterThan(0);
      const output = capture.text();
      for (const core of secret.cores)
        expect(output.includes(core), `${secret.id} via ${carrier}`).toBe(false);
    },
  );

  it('[NFR-SEC-06] pino redact paths alone protect the usual header and credential locations', () => {
    const lines: string[] = [];
    const bare = pino(
      { redact: { paths: [...PINO_REDACT_PATHS], censor: '[REDACTED]' } },
      { write: (c: string) => void lines.push(c) },
    );
    bare.info({
      headers: {
        authorization: 'fakeA',
        cookie: 'fakeB',
        'set-cookie': ['fakeC'],
        'x-api-key': 'fakeD',
      },
      req: { headers: { authorization: 'fakeE' }, body: { note: 'fakeF' } },
      password: 'fakeG',
      body: {
        password: 'fakeH',
        token: 'fakeI',
        apiKey: 'fakeJ',
        connectionString: 'fakeK',
        secret: 'fakeL',
      },
      config: { accessToken: 'keepMeBecauseOnlyScrubberSeesIt' },
    });
    const output = lines.join('');
    for (const leaked of [
      'fakeA',
      'fakeB',
      'fakeC',
      'fakeD',
      'fakeE',
      'fakeF',
      'fakeG',
      'fakeH',
      'fakeI',
      'fakeJ',
      'fakeK',
      'fakeL',
    ]) {
      expect(output).not.toContain(leaked);
    }
  });

  it('[NFR-SEC-06] never lets child options replace the scrubbing formatters, serialisers or redact paths', () => {
    const { logger, capture } = build();
    const [secret] = fakeSecrets();
    const hostile = logger.child(
      { component: 'x' },
      {
        formatters: { log: (object: object) => object },
        redact: [],
        serializers: {
          msg: (value: unknown) => value,
          err: (value: unknown) => value,
          custom: () => 'ok',
        },
      },
    );
    hostile.info({ custom: 1 }, `leak ${secret?.text ?? ''}`);
    hostile.error({ err: new Error(secret?.text ?? '') }, 'x');
    for (const core of secret?.cores ?? []) expect(capture.text()).not.toContain(core);
    expect(capture.records()[0]?.custom).toBe('ok');
  });

  it('[NFR-SEC-06] applies an injected redactor to messages, fields, bindings and errors', () => {
    const { logger, capture } = build({
      redact: (text) => text.replace(/INTERNAL-ONLY/g, '[INTERNAL]'),
    });
    logger
      .child({ owner: 'INTERNAL-ONLY team' })
      .info({ detail: 'INTERNAL-ONLY detail' }, 'INTERNAL-ONLY message');
    logger.error(new Error('INTERNAL-ONLY failure'));
    expect(capture.text()).not.toContain('INTERNAL-ONLY');
    expect(capture.text()).toContain('[INTERNAL]');
  });

  it('[NFR-SEC-06] fails closed and reports when the injected redactor throws', () => {
    const errors: unknown[] = [];
    const { logger, capture } = build({
      redact: () => {
        throw new Error('redactor exploded');
      },
      onRedactionError: (error) => errors.push(error),
    });
    logger.info({ detail: 'sensitive free text' }, 'sensitive message');
    expect(capture.text()).not.toContain('sensitive');
    expect(capture.text()).toContain('[REDACTED:redactor-failed]');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('[NFR-SEC-06] supports extra sensitive keys and reports redaction events without values', () => {
    const rules: string[] = [];
    const { logger, capture } = build({
      extraSensitiveKeys: ['internalTicketRef'],
      onRedaction: (rule) => rules.push(rule),
    });
    logger.info({ internalTicketRef: 'TCK-1', note: 'password=fakeHunter2Value' }, 'x');
    expect(capture.text()).not.toContain('TCK-1');
    expect(capture.text()).not.toContain('fakeHunter2Value');
    expect(rules).toContain('secret-assignment');
  });
});

describe('request and response serialisers', () => {
  it('[NFR-SEC-06] logs method, sanitised url and remote address, never headers or query secrets', () => {
    const { logger, capture } = build();
    logger.info(
      {
        req: {
          id: 'req_abc',
          method: 'GET',
          url: '/api/v1/cases?limit=5&sig=fakeSignature123&access_token=fakeAccessToken123',
          headers: {
            authorization: 'Bearer fakeBearerToken0123456789abcdef',
            'user-agent': 'vitest',
          },
          ip: '10.0.0.7',
        },
        res: {
          statusCode: 200,
          headers: { 'content-length': '42', 'set-cookie': 'sid=fakeSessionCookie0123456789' },
        },
      },
      'request completed',
    );
    const [record] = capture.records();
    expect(record?.req).toEqual({
      id: 'req_abc',
      method: 'GET',
      url: '/api/v1/cases?limit=5&sig=[REDACTED]&access_token=[REDACTED]',
      remoteAddress: '10.0.0.7',
      userAgent: 'vitest',
    });
    expect(record?.res).toEqual({ statusCode: 200, contentLength: 42 });
    for (const leaked of [
      'fakeSignature123',
      'fakeAccessToken123',
      'fakeBearerToken',
      'fakeSessionCookie',
    ]) {
      expect(capture.text()).not.toContain(leaked);
    }
  });
});

describe('child loggers', () => {
  it('[NFR-OBS-01] merge bindings, nest, and keep the base fields and correlation context', () => {
    const { logger, capture } = build();
    const child = logger.child({ component: 'db' }).child({ operation: 'select' });
    runWithContext({ requestId: 'req_child_001' }, () => child.info('query done'));
    expect(capture.records()[0]).toMatchObject({
      service: 'caseguard-api',
      component: 'db',
      operation: 'select',
      requestId: 'req_child_001',
      msg: 'query done',
    });
  });

  it('[NFR-OBS-01] support level overrides and reject an unknown child level', () => {
    const { logger, capture } = build({ level: 'info' });
    const quiet = logger.child({ component: 'noisy' }, { level: 'error' });
    quiet.info('hidden');
    quiet.error('shown');
    expect(capture.records().map((record) => record.msg)).toEqual(['shown']);
    expect(() => logger.child({ a: 1 }, { level: 'verbose' })).toThrow(RangeError);
  });
});

describe('pretty output (local development only)', () => {
  it('[NFR-OBS-01] renders readable lines in local, development and test, and never leaks secrets', () => {
    for (const env of ['local', 'development', 'test'] as const) {
      const { logger, capture } = build({ env, pretty: true });
      runWithContext({ requestId: 'req_pretty_001' }, () => {
        logger.info(
          { headers: { authorization: 'Bearer fakeBearerToken0123456789abcdef' }, n: 2 },
          'hello world',
        );
        logger.error(new Error('boom password=fakeHunter2Value'));
      });
      const text = capture.text();
      expect(text).toContain('INFO');
      expect(text).toContain('hello world');
      expect(text).toContain('requestId=req_pretty_001');
      expect(text).toContain('ERROR');
      expect(text).not.toContain('fakeBearerToken');
      expect(text).not.toContain('fakeHunter2Value');
      expect(() => {
        JSON.parse(text.split('\n')[0] ?? '');
      }).toThrow();
    }
  });

  it('[NFR-SEC-06] keeps machine-readable JSON in staging and production even when pretty is requested', () => {
    for (const env of ['staging', 'production'] as const) {
      const { logger, capture } = build({ env, pretty: true });
      logger.info('hello');
      expect(capture.records()[0]?.msg).toBe('hello');
    }
  });

  it('[NFR-OBS-01] passes foreign non-JSON lines through and colours levels on request', () => {
    const written: string[] = [];
    const destination = createPrettyDestination(
      { write: (chunk) => void written.push(chunk) },
      { color: true },
    );
    destination.write('not json at all\n');
    destination.write('{"level":"warn","time":"2026-01-01T00:00:00.000Z","msg":"careful"}\n');
    expect(written[0]).toBe('not json at all\n');
    expect(written[1]).toContain('\u001b[33mWARN \u001b[0m');
    expect(written[1]).toContain('careful');
  });
});
