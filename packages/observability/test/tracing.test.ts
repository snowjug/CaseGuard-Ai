import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type ContextManager,
  type Exception,
  type Link,
  type Span,
  type SpanAttributes,
  type SpanAttributeValue,
  type SpanContext,
  type SpanOptions,
  type SpanStatus,
  type TimeInput,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  createRequestContext,
  getActiveTraceIds,
  parseTraceparent,
  propagationHeaders,
  recordSpanError,
  runWithContext,
  sanitizeSpanAttributes,
  createScrubber,
  withSpan,
} from '../src';
import { createCapture, seededBytes } from './helpers/fakes';
import { fakeSecrets } from './helpers/secrets';

class RecordingSpan implements Span {
  readonly attributes: Record<string, SpanAttributeValue | undefined> = {};
  readonly exceptions: Exception[] = [];
  status: SpanStatus | undefined;
  endCount = 0;
  name: string;
  constructor(
    name: string,
    private readonly context: SpanContext,
    readonly options: SpanOptions | undefined,
    private readonly log: string[],
  ) {
    this.name = name;
    Object.assign(this.attributes, options?.attributes);
  }
  spanContext(): SpanContext {
    return this.context;
  }
  setAttribute(key: string, value: SpanAttributeValue): this {
    this.attributes[key] = value;
    return this;
  }
  setAttributes(attributes: SpanAttributes): this {
    Object.assign(this.attributes, attributes);
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(_link: Link): this {
    return this;
  }
  addLinks(_links: Link[]): this {
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
  updateName(name: string): this {
    this.name = name;
    return this;
  }
  end(_endTime?: TimeInput): void {
    this.endCount += 1;
    this.log.push(`end:${this.name}`);
  }
  isRecording(): boolean {
    return true;
  }
  recordException(exception: Exception): void {
    this.exceptions.push(exception);
  }
}

class RecordingTracer implements Tracer {
  readonly spans: RecordingSpan[] = [];
  readonly log: string[] = [];
  private counter = 0;

  startSpan(name: string, options?: SpanOptions): Span {
    this.counter += 1;
    const span = new RecordingSpan(
      name,
      {
        traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
        spanId: this.counter.toString(16).padStart(16, '0'),
        traceFlags: 1,
      },
      options,
      this.log,
    );
    this.spans.push(span);
    return span;
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    ctx: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    first: SpanOptions | F,
    second?: Context | F,
    third?: F,
  ): ReturnType<F> {
    const options = typeof first === 'function' ? undefined : first;
    const fn = (
      typeof first === 'function' ? first : typeof second === 'function' ? second : third
    ) as F;
    const span = this.startSpan(name, options);
    return context.with(trace.setSpan(context.active(), span), () => fn(span)) as ReturnType<F>;
  }
}

function setupGlobalOtel(tracer: Tracer): void {
  const storage = new AsyncLocalStorage<Context>();
  const manager: ContextManager = {
    active: () => storage.getStore() ?? ROOT_CONTEXT,
    with: (ctx, fn, thisArg, ...args) => storage.run(ctx, () => fn.call(thisArg, ...args)),
    bind: (_ctx, target) => target,
    enable() {
      return this;
    },
    disable() {
      return this;
    },
  };
  const provider: TracerProvider = { getTracer: () => tracer };
  context.setGlobalContextManager(manager);
  trace.setGlobalTracerProvider(provider);
}

afterEach(() => {
  trace.disable();
  context.disable();
});

describe('withSpan without an OpenTelemetry SDK', () => {
  it('[NFR-OBS-01] is a transparent no-op: returns values (sync and async) and runs the callback once', async () => {
    let calls = 0;
    expect(
      await withSpan('db.query', { table: 'cases' }, () => {
        calls += 1;
        return 42;
      }),
    ).toBe(42);
    expect(await withSpan('db.query', undefined, async () => 'async value')).toBe('async value');
    expect(calls).toBe(1);
  });

  it('[NFR-OBS-01] rethrows the original error untouched and still ends cleanly', async () => {
    const failure = new Error('db exploded');
    await expect(
      withSpan('db.query', {}, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    const thrown = { not: 'an error' };
    await expect(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- non-Error rejections must pass through untouched
      withSpan('x', {}, () => Promise.reject(thrown)),
    ).rejects.toBe(thrown);
  });

  it('[NFR-OBS-01] hands out a non-recording span and exposes no trace ids', async () => {
    await withSpan('noop', {}, (span) => {
      expect(span.isRecording()).toBe(false);
      expect(getActiveTraceIds()).toBeUndefined();
      expect(() => {
        span.setAttribute('a', 1);
        recordSpanError(span, new Error('ignored'));
        span.end();
      }).not.toThrow();
    });
    expect(getActiveTraceIds()).toBeUndefined();
  });

  it('[NFR-OBS-01] keeps logs and propagation on the request context when no span is active', async () => {
    const capture = createCapture();
    const logger = createLogger({
      service: 's',
      version: '1',
      env: 'test',
      level: 'info',
      destination: capture.destination,
    });
    const requestContext = createRequestContext({
      generateRequestId: () => 'req_noop_000001',
      randomBytes: seededBytes(4),
    });
    await runWithContext(requestContext, () =>
      withSpan('work', {}, () => {
        logger.info('inside span');
        expect(parseTraceparent(propagationHeaders().traceparent)?.parentId).toBe(
          requestContext.spanId,
        );
      }),
    );
    expect(capture.records()[0]).toMatchObject({
      traceId: requestContext.traceId,
      spanId: requestContext.spanId,
    });
  });
});

describe('withSpan with a recording tracer', () => {
  it('[NFR-OBS-01] [NFR-SEC-06] sanitises attributes before they reach the span', async () => {
    const tracer = new RecordingTracer();
    const [bearer] = fakeSecrets();
    await withSpan(
      'case.analyze',
      {
        'case.id': 'case_abc',
        count: 3,
        ratio: 0.5,
        ok: true,
        when: new Date('2026-01-02T03:04:05.000Z'),
        big: 10n,
        note: `retry ${bearer?.text ?? ''}`,
        long: 'x'.repeat(1000),
        password: 'fakeHunter2Value',
        'user.email': 'fake.person@example.test',
        'bad key!': 'dropped',
        nested: { a: 1 },
        nan: Number.NaN,
        undef: undefined,
        nil: null,
        tags: ['a', 'b', 3, 'c'],
        scores: [1, 2, 3],
        empty: [],
        fn: () => 1,
      },
      () => undefined,
      { tracer },
    );
    const span = tracer.spans[0];
    expect(span?.attributes).toMatchObject({
      'case.id': 'case_abc',
      count: 3,
      ratio: 0.5,
      ok: true,
      when: '2026-01-02T03:04:05.000Z',
      big: '10',
      password: '[REDACTED]',
      'user.email': '[REDACTED]',
      tags: ['a', 'b', 'c'],
      scores: [1, 2, 3],
    });
    expect(String(span?.attributes.long).length).toBeLessThanOrEqual(256);
    for (const dropped of ['bad key!', 'nested', 'nan', 'undef', 'nil', 'empty', 'fn']) {
      expect(span?.attributes).not.toHaveProperty(dropped);
    }
    const text = JSON.stringify(span?.attributes);
    for (const core of bearer?.cores ?? []) expect(text).not.toContain(core);
    expect(text).not.toContain('fakeHunter2Value');
    expect(text).not.toContain('fake.person@example.test');
  });

  it('[NFR-OBS-01] limits attribute count and array length', () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_u, i) => [`k${i}`, i]));
    const attributes = sanitizeSpanAttributes(many, createScrubber());
    expect(Object.keys(attributes)).toHaveLength(32);
    expect(
      sanitizeSpanAttributes({ list: Array.from({ length: 100 }, (_u, i) => i) }, createScrubber())
        .list,
    ).toHaveLength(16);
    expect(
      sanitizeSpanAttributes({ a: 1, b: 2, c: 3 }, createScrubber(), { maxAttributes: 2 }),
    ).toEqual({ a: 1, b: 2 });
  });

  it('[NFR-OBS-01] sanitises the span name and passes the kind through', async () => {
    const tracer = new RecordingTracer();
    await withSpan('line one\nline two password=fakeHunter2Value', {}, () => undefined, {
      tracer,
      kind: SpanKind.CLIENT,
    });
    await withSpan('   ', {}, () => undefined, { tracer });
    await withSpan('x'.repeat(500), {}, () => undefined, { tracer });
    expect(tracer.spans[0]?.name).not.toContain('\n');
    expect(tracer.spans[0]?.name).not.toContain('fakeHunter2Value');
    expect(tracer.spans[0]?.options?.kind).toBe(SpanKind.CLIENT);
    expect(tracer.spans[1]?.name).toBe('span');
    expect(tracer.spans[2]?.name.length).toBeLessThanOrEqual(128);
    expect(tracer.spans[1]?.options?.kind).toBe(SpanKind.INTERNAL);
  });

  it('[NFR-OBS-01] ends the span exactly once, after an async callback settles', async () => {
    const tracer = new RecordingTracer();
    const result = await withSpan(
      'async.work',
      {},
      async () => {
        tracer.log.push('work:start');
        await new Promise((resolve) => setTimeout(resolve, 5));
        tracer.log.push('work:end');
        return 'done';
      },
      { tracer },
    );
    expect(result).toBe('done');
    expect(tracer.log).toEqual(['work:start', 'work:end', 'end:async.work']);
    expect(tracer.spans[0]?.endCount).toBe(1);
    expect(tracer.spans[0]?.status).toBeUndefined();
  });

  it('[NFR-SEC-06] records a failure with a scrubbed message, ERROR status and no stack by default', async () => {
    const tracer = new RecordingTracer();
    const [bearer, , jwt] = fakeSecrets();
    const failure = new Error(`upstream failed ${bearer?.text ?? ''} and ${jwt?.text ?? ''}`);
    await expect(
      withSpan(
        'call.upstream',
        {},
        () => {
          throw failure;
        },
        { tracer },
      ),
    ).rejects.toBe(failure);
    const span = tracer.spans[0];
    expect(span?.endCount).toBe(1);
    expect(span?.status?.code).toBe(SpanStatusCode.ERROR);
    expect(span?.exceptions).toHaveLength(1);
    const recorded = span?.exceptions[0] as { name?: string; message?: string; stack?: string };
    expect(recorded.name).toBe('Error');
    expect(recorded).not.toHaveProperty('stack');
    const text = JSON.stringify([span?.status, span?.exceptions]);
    for (const secret of [bearer, jwt])
      for (const core of secret?.cores ?? []) expect(text).not.toContain(core);
    expect((span?.status?.message ?? '').length).toBeLessThanOrEqual(200);
  });

  it('[NFR-OBS-01] can attach a scrubbed stack on request', async () => {
    const tracer = new RecordingTracer();
    await expect(
      withSpan(
        'x',
        {},
        () => {
          throw new Error('boom');
        },
        { tracer, recordStack: true },
      ),
    ).rejects.toThrow('boom');
    expect((tracer.spans[0]?.exceptions[0] as { stack?: string }).stack).toContain('boom');
  });

  it('[NFR-OBS-01] handles a non-Error rejection and still ends the span', async () => {
    const tracer = new RecordingTracer();
    await expect(
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a thrown string must still be scrubbed and recorded
      withSpan('x', {}, () => Promise.reject('plain password=fakeHunter2Value'), {
        tracer,
      }),
    ).rejects.toBe('plain password=fakeHunter2Value');
    expect(JSON.stringify(tracer.spans[0]?.exceptions)).not.toContain('fakeHunter2Value');
    expect(tracer.spans[0]?.endCount).toBe(1);
  });
});

describe('integration with the OpenTelemetry API registered', () => {
  it('[NFR-OBS-01] exposes active span ids, and logs and outgoing headers prefer them', async () => {
    const tracer = new RecordingTracer();
    setupGlobalOtel(tracer);
    const capture = createCapture();
    const logger = createLogger({
      service: 's',
      version: '1',
      env: 'test',
      level: 'info',
      destination: capture.destination,
    });
    const requestContext = createRequestContext({
      generateRequestId: () => 'req_otel_000001',
      randomBytes: seededBytes(8),
    });

    await runWithContext(requestContext, async () => {
      await withSpan('outer', {}, async () => {
        logger.info('in outer');
        await withSpan('inner', {}, async () => {
          await Promise.resolve();
          logger.info('in inner');
          expect(getActiveTraceIds()).toMatchObject({
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            spanId: '0000000000000002',
            traceFlags: '01',
          });
          expect(parseTraceparent(propagationHeaders().traceparent)).toMatchObject({
            traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
            parentId: '0000000000000002',
          });
        });
        logger.info('back in outer');
      });
      logger.info('after spans');
    });

    const records = capture.records();
    expect(records.map((r) => [r.msg, r.traceId, r.spanId])).toEqual([
      ['in outer', '4bf92f3577b34da6a3ce929d0e0e4736', '0000000000000001'],
      ['in inner', '4bf92f3577b34da6a3ce929d0e0e4736', '0000000000000002'],
      ['back in outer', '4bf92f3577b34da6a3ce929d0e0e4736', '0000000000000001'],
      ['after spans', requestContext.traceId, requestContext.spanId],
    ]);
    expect(records.every((r) => r.requestId === 'req_otel_000001')).toBe(true);
    expect(getActiveTraceIds()).toBeUndefined();
  });
});
