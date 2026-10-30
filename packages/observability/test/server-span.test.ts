import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
} from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createScrubber,
  getActiveTraceIds,
  getContextLogFields,
  getRegisteredTracer,
  hasTracerProvider,
  propagationHeaders,
  runWithContext,
  SERVER_SPAN_ATTRIBUTES,
  startServerSpan,
  UNMATCHED_ROUTE,
} from '../src';
import { installInMemoryTracing, type InMemoryTracing } from '../src/testing';
import { seededRandom } from './helpers/fakes';
import { fakeSecrets } from './helpers/secrets';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

let tracing: InMemoryTracing | undefined;

function install(options: Parameters<typeof installInMemoryTracing>[0] = {}): InMemoryTracing {
  tracing = installInMemoryTracing(options);
  return tracing;
}

afterEach(() => {
  tracing?.uninstall();
  tracing = undefined;
  trace.disable();
  context.disable();
});

function onlySpan(installed: InMemoryTracing) {
  expect(installed.spans).toHaveLength(1);
  const [span] = installed.spans;
  if (span === undefined) throw new Error('expected one recorded span');
  return span;
}

describe('hasTracerProvider and getRegisteredTracer', () => {
  it('[NFR-OBS-01] report no provider while only the API no-op exists, and a tracer once one is registered', () => {
    expect(hasTracerProvider()).toBe(false);
    expect(getRegisteredTracer()).toBeUndefined();

    const installed = install();
    expect(hasTracerProvider()).toBe(true);
    expect(getRegisteredTracer()).toBeDefined();
    installed.uninstall();
    expect(hasTracerProvider()).toBe(false);
  });

  it('[NFR-OBS-01] look the tracer up on every call, so a provider registered later is picked up', () => {
    expect(getRegisteredTracer('late')).toBeUndefined();
    const installed = install();
    getRegisteredTracer('late');
    expect(installed.provider.tracerNames).toContain('late');
  });
});

describe('startServerSpan while no SDK is registered', () => {
  it('[NFR-OBS-01] returns undefined and does no span or sanitising work', () => {
    let scrubberCalls = 0;
    const real = createScrubber();
    const counting = {
      ...real,
      text: (...args: Parameters<typeof real.text>) => {
        scrubberCalls += 1;
        return real.text(...args);
      },
      value: (...args: Parameters<typeof real.value>) => {
        scrubberCalls += 1;
        return real.value(...args);
      },
      error: (...args: Parameters<typeof real.error>) => {
        scrubberCalls += 1;
        return real.error(...args);
      },
    };

    const span = startServerSpan(
      {
        method: 'GET',
        route: '/api/v1/cases/:caseId',
        routeId: 'cases.get',
        traceparent: TRACEPARENT,
      },
      { scrubber: counting },
    );

    expect(span).toBeUndefined();
    expect(scrubberCalls).toBe(0);
    expect(getActiveTraceIds()).toBeUndefined();
  });
});

describe('startServerSpan naming and attributes', () => {
  it('[NFR-OBS-01] creates one SERVER span named after the route id, with only the allow-listed attributes', () => {
    const installed = install();
    const handle = startServerSpan({
      method: 'post',
      route: '/api/v1/cases/:caseId/analysis',
      routeId: 'analysis.start',
      requestId: 'req_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    });
    expect(handle).toBeDefined();
    handle?.end(202);

    const span = onlySpan(installed);
    expect(span.name).toBe('POST analysis.start');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes).toEqual({
      'http.request.method': 'POST',
      'http.route': '/api/v1/cases/:caseId/analysis',
      'cg.route_id': 'analysis.start',
      'cg.request_id': 'req_01HZZZZZZZZZZZZZZZZZZZZZZZ',
      'http.response.status_code': 202,
    });
    expect(span.endCount).toBe(1);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('[NFR-OBS-01] names a span after the route pattern when there is no route id, and "unmatched" when there is neither', () => {
    const installed = install();
    startServerSpan({ method: 'GET', route: '/api/v1/openapi.json' })?.end(200);
    startServerSpan({ method: 'GET' })?.end(404);

    expect(installed.spans.map((span) => span.name)).toEqual([
      'GET /api/v1/openapi.json',
      `GET ${UNMATCHED_ROUTE}`,
    ]);
    expect(installed.spans[1]?.attributes).not.toHaveProperty('http.route');
    expect(installed.spans[1]?.attributes).not.toHaveProperty('cg.route_id');
  });

  it.each([
    ['an absolute URL', 'https://api.example.test/api/v1/cases/case_secret_123?q=ssn'],
    ['a path with a query string', '/api/v1/cases/case_secret_123?q=ssn'],
    ['a path with a fragment', '/api/v1/cases/case_secret_123#frag'],
    ['whitespace', '/api/v1/cases/case secret'],
    ['a line break', '/api/v1/cases/x\r\nSet-Cookie: a=b'],
    ['a missing leading slash', 'api/v1/cases'],
    ['more than 200 characters', `/${'a'.repeat(200)}`],
    ['non-ASCII text', '/api/v1/cases/\u00e9\u00e8'],
  ])('[NFR-SEC-06] ignores a route that is %s', (_label, route) => {
    const installed = install();
    startServerSpan({ method: 'GET', route })?.end(200);

    const span = onlySpan(installed);
    expect(span.name).toBe(`GET ${UNMATCHED_ROUTE}`);
    expect(span.attributes).not.toHaveProperty('http.route');
    expect(JSON.stringify(span)).not.toContain('case_secret_123');
  });

  it.each([
    ['a path', 'cases/create'],
    ['a space', 'cases create'],
    ['a leading digit', '1cases'],
    ['a query', 'cases?x=1'],
    ['more than 64 characters', `a${'b'.repeat(64)}`],
  ])('[NFR-SEC-06] ignores a route id that is %s', (_label, routeId) => {
    const installed = install();
    startServerSpan({ method: 'GET', route: '/api/v1/cases', routeId })?.end(200);

    const span = onlySpan(installed);
    expect(span.name).toBe('GET /api/v1/cases');
    expect(span.attributes).not.toHaveProperty('cg.route_id');
  });

  it.each([
    ['get', 'GET'],
    ['DELETE', 'DELETE'],
    ['Patch', 'PATCH'],
    ['BREW', '_OTHER'],
    ['GET /secret?x=1', '_OTHER'],
    ['', '_OTHER'],
  ])('[NFR-SEC-06] normalises the method %j to %s', (method, expected) => {
    const installed = install();
    startServerSpan({ method, routeId: 'cases.get' })?.end(200);

    const span = onlySpan(installed);
    expect(span.attributes['http.request.method']).toBe(expected);
    expect(span.name).toBe(`${expected} cases.get`);
  });

  it.each([
    ['a CRLF injection', 'req_ok\r\nx-injected: 1'],
    ['more than 128 characters', `r${'x'.repeat(128)}`],
    ['a space', 'req with space'],
    ['a script', '<script>alert(1)</script>'],
  ])('[NFR-SEC-06] drops a request id with %s', (_label, requestId) => {
    const installed = install();
    startServerSpan({ method: 'GET', routeId: 'cases.get', requestId })?.end(200);

    expect(onlySpan(installed).attributes).not.toHaveProperty('cg.request_id');
  });

  it('[NFR-SEC-06] only ever attaches attributes from the allow-list, whatever the input', () => {
    const installed = install();
    const allowed = new Set<string>(Object.values(SERVER_SPAN_ATTRIBUTES));
    const random = seededRandom(20261030);
    const alphabet = [
      'a',
      'Z',
      '0',
      '/',
      ':',
      '?',
      '#',
      ' ',
      '\r',
      '\n',
      '%',
      '.',
      '-',
      '_',
      '\u00e9',
    ];
    const word = (): string =>
      Array.from(
        { length: Math.floor(random() * 40) },
        () => alphabet[Math.floor(random() * alphabet.length)],
      ).join('');

    for (let index = 0; index < 300; index += 1) {
      startServerSpan({
        method: word(),
        route: `/${word()}`,
        routeId: word(),
        requestId: word(),
        traceparent: word(),
        tracestate: word(),
      })?.end(index % 2 === 0 ? 200 : 503);
    }

    expect(installed.spans).toHaveLength(300);
    for (const span of installed.spans) {
      for (const key of Object.keys(span.attributes)) expect(allowed.has(key)).toBe(true);
      expect(span.name).not.toMatch(/[\r\n?#]/);
      expect(span.name.length).toBeLessThanOrEqual(128);
    }
  });
});

describe('startServerSpan parent handling', () => {
  it('[NFR-OBS-01] continues a valid inbound traceparent as a remote parent', () => {
    const installed = install();
    const handle = startServerSpan({
      method: 'GET',
      routeId: 'cases.get',
      traceparent: TRACEPARENT,
    });
    handle?.end(200);

    const span = onlySpan(installed);
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanId).toBe(PARENT_ID);
    expect(span.parentIsRemote).toBe(true);
    expect(handle?.traceId).toBe(TRACE_ID);
    expect(handle?.spanId).toBe(span.spanContext().spanId);
  });

  it.each([
    ['upper-case hex', TRACEPARENT.toUpperCase()],
    ['a short value', '00-abc-def-01'],
    ['version ff', `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${PARENT_ID}-01`],
    ['an all-zero parent id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
    ['trailing data on version 00', `${TRACEPARENT}-extra`],
    ['a CRLF injection', `${TRACEPARENT}\r\nx-evil: 1`],
    ['an array of headers', [TRACEPARENT, TRACEPARENT]],
    ['a number', 42],
    ['an empty string', ''],
  ])(
    '[NFR-SEC-06] ignores a traceparent that is %s and starts a new trace',
    (_label, traceparent) => {
      const installed = install();
      const handle = startServerSpan({ method: 'GET', routeId: 'cases.get', traceparent });
      handle?.end(200);

      const span = onlySpan(installed);
      expect(span.spanContext().traceId).not.toBe(TRACE_ID);
      expect(span.parentSpanId).toBeUndefined();
      expect(span.parentIsRemote).toBe(false);
    },
  );

  it('[NFR-OBS-01] hands a validated tracestate to the SDK together with the remote parent', () => {
    const installed = install();
    const real = installed.provider.getTracer('test');
    const seen: Context[] = [];
    const spy: Tracer = {
      startSpan: (name: string, options?: SpanOptions, ctx?: Context): Span => {
        if (ctx !== undefined) seen.push(ctx);
        return real.startSpan(name, options, ctx);
      },
      startActiveSpan: real.startActiveSpan.bind(real),
    };

    startServerSpan(
      { method: 'GET', traceparent: TRACEPARENT, tracestate: 'vendor=opaque,other=value' },
      { tracer: spy },
    )?.end(200);
    startServerSpan(
      { method: 'GET', traceparent: TRACEPARENT, tracestate: 'bad state\r\n' },
      { tracer: spy },
    )?.end(200);

    const [valid, invalid] = seen.map((ctx) => trace.getSpanContext(ctx));
    expect(valid?.traceState?.serialize()).toBe('vendor=opaque,other=value');
    expect(invalid?.traceState).toBeUndefined();
  });

  it('[NFR-OBS-01] becomes a child of a span another instrumentation already made active', () => {
    const installed = install();
    const outer = installed.provider.getTracer('other').startSpan('outer');
    const outerContext = outer.spanContext();

    context.with(trace.setSpan(context.active(), outer), () => {
      startServerSpan({ method: 'GET', routeId: 'cases.get', traceparent: TRACEPARENT })?.end(200);
    });

    const child = installed.spans.find((span) => span.name === 'GET cases.get');
    expect(child?.spanContext().traceId).toBe(outerContext.traceId);
    expect(child?.parentSpanId).toBe(outerContext.spanId);
  });
});

describe('startServerSpan outcome', () => {
  it('[NFR-OBS-01] records the status code and leaves the status unset below 500', () => {
    const installed = install();
    for (const code of [200, 301, 404, 429]) startServerSpan({ method: 'GET' })?.end(code);

    expect(installed.spans.map((span) => span.attributes['http.response.status_code'])).toEqual([
      200, 301, 404, 429,
    ]);
    expect(installed.spans.every((span) => span.status.code === SpanStatusCode.UNSET)).toBe(true);
    expect(installed.spans.every((span) => span.exceptions.length === 0)).toBe(true);
  });

  it('[NFR-OBS-01] marks a 5xx without an error as ERROR with a generic status message', () => {
    const installed = install();
    startServerSpan({ method: 'GET', routeId: 'cases.get' })?.end(503);

    const span = onlySpan(installed);
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: 'HTTP 503' });
    expect(span.exceptions).toHaveLength(0);
  });

  it('[NFR-SEC-06] records a captured error on a 5xx span with the secrets scrubbed and no stack', () => {
    const installed = install();
    const secrets = fakeSecrets();
    const handle = startServerSpan({ method: 'POST', routeId: 'cases.create' });
    const error = new Error(`upstream failed: ${secrets.map((secret) => secret.text).join(' | ')}`);
    handle?.captureError(error);
    handle?.end(500);

    const span = onlySpan(installed);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.exceptions).toHaveLength(1);
    const exported = JSON.stringify([span.status, span.exceptions, span.events]);
    for (const secret of secrets) {
      for (const core of secret.cores) expect(exported).not.toContain(core);
    }
    const event = span.events.find((item) => item.name === 'exception');
    expect(event?.attributes['exception.type']).toBe('Error');
    expect(event?.attributes).not.toHaveProperty('exception.stacktrace');
  });

  it('[NFR-OBS-01] does not record an error that ended in a 4xx (validation and authorisation failures)', () => {
    const installed = install();
    const handle = startServerSpan({ method: 'POST', routeId: 'cases.create' });
    handle?.captureError(new Error('validation failed'));
    handle?.end(422);

    const span = onlySpan(installed);
    expect(span.exceptions).toHaveLength(0);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('[NFR-OBS-01] ends the span exactly once and ignores later calls', () => {
    const installed = install();
    const handle = startServerSpan({ method: 'GET', routeId: 'cases.get' });
    handle?.end(200);
    handle?.end(500);
    handle?.captureError(new Error('late'));
    handle?.end(503);

    const span = onlySpan(installed);
    expect(span.endCount).toBe(1);
    expect(span.attributes['http.response.status_code']).toBe(200);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('[NFR-OBS-01] ends an aborted request without a status code', () => {
    const installed = install();
    startServerSpan({ method: 'GET', routeId: 'cases.get' })?.end();

    const span = onlySpan(installed);
    expect(span.endCount).toBe(1);
    expect(span.attributes).not.toHaveProperty('http.response.status_code');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it.each([0, 99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    '[NFR-SEC-06] records no status for the invalid code %s',
    (code) => {
      const installed = install();
      startServerSpan({ method: 'GET' })?.end(code);

      const span = onlySpan(installed);
      expect(span.attributes).not.toHaveProperty('http.response.status_code');
      expect(span.endCount).toBe(1);
    },
  );
});

describe('startServerSpan correlation', () => {
  it('[NFR-OBS-01] makes the span active inside run(), so log fields and outgoing headers carry its ids', () => {
    const installed = install();
    let inside: ReturnType<typeof getContextLogFields> | undefined;
    let outgoing: Record<string, string> = {};

    runWithContext({ requestId: 'req_correlation_1' }, () => {
      const handle = startServerSpan({
        method: 'GET',
        routeId: 'cases.get',
        traceparent: TRACEPARENT,
      });
      handle?.run(() => {
        inside = getContextLogFields();
        outgoing = propagationHeaders();
        expect(trace.getActiveSpan()?.spanContext().spanId).toBe(handle.spanId);
        expect(getActiveTraceIds()?.traceId).toBe(TRACE_ID);
      });
      handle?.end(200);
    });

    const span = onlySpan(installed);
    expect(inside).toMatchObject({
      requestId: 'req_correlation_1',
      traceId: TRACE_ID,
      spanId: span.spanContext().spanId,
    });
    expect(outgoing['traceparent']).toBe(`00-${TRACE_ID}-${span.spanContext().spanId}-01`);
    expect(trace.getActiveSpan()).toBeUndefined();
  });

  it('[NFR-OBS-01] keeps log lines on the span ids even when the SDK has no context manager', () => {
    const installed = install({ contextManager: false });
    let fields: ReturnType<typeof getContextLogFields> | undefined;

    runWithContext(
      { requestId: 'req_correlation_2', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) },
      () => {
        const handle = startServerSpan({ method: 'GET', routeId: 'cases.get' });
        handle?.run(() => {
          fields = getContextLogFields();
        });
        handle?.end(200);
      },
    );

    const span = onlySpan(installed);
    expect(fields?.traceId).toBe(span.spanContext().traceId);
    expect(fields?.spanId).toBe(span.spanContext().spanId);
    expect(fields?.traceId).not.toBe('a'.repeat(32));
  });

  it('[NFR-OBS-01] keeps parallel requests apart', async () => {
    const installed = install();
    const seen: Record<string, string | undefined> = {};

    await Promise.all(
      ['one', 'two', 'three'].map((name, index) =>
        runWithContext({ requestId: `req_parallel_${name}` }, async () => {
          const handle = startServerSpan({ method: 'GET', routeId: `route.${name}` });
          await handle?.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5 - index));
            seen[name] = getContextLogFields().spanId;
          });
          handle?.end(200);
        }),
      ),
    );

    const bySpanName = new Map(
      installed.spans.map((span) => [span.name, span.spanContext().spanId]),
    );
    expect(seen['one']).toBe(bySpanName.get('GET route.one'));
    expect(seen['two']).toBe(bySpanName.get('GET route.two'));
    expect(seen['three']).toBe(bySpanName.get('GET route.three'));
    expect(new Set(Object.values(seen)).size).toBe(3);
  });
});

describe('startServerSpan when the SDK samples the request out', () => {
  it('[NFR-OBS-01] still propagates the ids but does no attribute or status work', () => {
    const installed = install({ sample: () => false });
    const handle = startServerSpan({
      method: 'GET',
      routeId: 'cases.get',
      traceparent: TRACEPARENT,
    });

    expect(handle).toBeDefined();
    expect(handle?.recording).toBe(false);
    expect(handle?.traceId).toBe(TRACE_ID);
    handle?.captureError(new Error('boom'));
    expect(() => handle?.end(500)).not.toThrow();
    expect(installed.spans).toHaveLength(0);
    expect(installed.provider.unsampled).toHaveLength(1);
  });
});

describe('startServerSpan with a tracer that returns an invalid span', () => {
  it('[NFR-OBS-01] gives up instead of tracking a span that cannot be correlated', () => {
    const noop = trace.getTracer('noop-probe');
    const handle = startServerSpan({ method: 'GET' }, { tracer: noop });

    expect(handle).toBeUndefined();
  });
});
