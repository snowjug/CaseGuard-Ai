import { IdSchema } from '@caseguard/schemas';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  acceptRequestId,
  correlationResponseHeaders,
  createIdGenerator,
  createRequestContext,
  formatTraceparent,
  generateSpanId,
  generateTraceId,
  getContext,
  getContextLogFields,
  getRequestId,
  isValidTraceparent,
  newRequestId,
  parseTraceparent,
  propagationHeaders,
  resolveRequestId,
  runWithContext,
  sanitizeTracestate,
  setContextValue,
} from '../src';
import { seededBytes } from './helpers/fakes';

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const PARENT_ID = '00f067aa0ba902b7';
const VALID_TRACEPARENT = `00-${TRACE_ID}-${PARENT_ID}-01`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('async context propagation', () => {
  it('[NFR-OBS-01] keeps the context across promises, timers, microtasks, nextTick and emitters', async () => {
    const seen: (string | undefined)[] = [];
    const emitter = new EventEmitter();
    await runWithContext({ requestId: 'req_propagation_01' }, async () => {
      emitter.on('tick', () => seen.push(getRequestId()));
      seen.push(getRequestId());
      await Promise.resolve();
      seen.push(getRequestId());
      await sleep(2);
      seen.push(getRequestId());
      await new Promise<void>((resolve) => setImmediate(resolve));
      seen.push(getRequestId());
      await new Promise<void>((resolve) => process.nextTick(resolve));
      seen.push(getRequestId());
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      seen.push(getRequestId());
      emitter.emit('tick');
      await Promise.all([
        sleep(1).then(() => seen.push(getRequestId())),
        Promise.resolve().then(() => seen.push(getRequestId())),
      ]);
    });
    expect(new Set(seen)).toEqual(new Set(['req_propagation_01']));
    expect(seen.length).toBeGreaterThanOrEqual(9);
    expect(getRequestId()).toBeUndefined();
  });

  it('[NFR-OBS-01] never leaks values between 200 parallel requests', async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_unused, index) =>
        runWithContext(
          { requestId: `req_parallel_${index}`, tenantId: `tenant_${index % 7}` },
          async () => {
            const observed: string[] = [];
            const record = (): void => {
              const fields = getContextLogFields();
              observed.push(
                `${fields.requestId ?? ''}|${fields.tenantId ?? ''}|${fields.userId ?? ''}`,
              );
            };
            record();
            await sleep((index * 7) % 5);
            setContextValue('userId', `user_${index}`);
            record();
            await Promise.resolve();
            await sleep((index * 3) % 4);
            record();
            return { index, observed };
          },
        ),
      ),
    );
    for (const { index, observed } of results) {
      expect(observed[0]).toBe(`req_parallel_${index}|tenant_${index % 7}|`);
      expect(observed[1]).toBe(`req_parallel_${index}|tenant_${index % 7}|user_${index}`);
      expect(observed[2]).toBe(observed[1]);
    }
  });

  it('[NFR-OBS-01] nests contexts: inner values layer over the outer, and the outer is restored afterwards', async () => {
    await runWithContext({ requestId: 'req_outer_0001', tenantId: 'tenant_outer' }, async () => {
      await runWithContext({ requestId: 'req_inner_0001' }, async () => {
        expect(getContext()).toMatchObject({
          requestId: 'req_inner_0001',
          tenantId: 'tenant_outer',
        });
        setContextValue('userId', 'user_inner');
        await Promise.resolve();
        expect(getContext()?.userId).toBe('user_inner');
      });
      expect(getContext()).toMatchObject({ requestId: 'req_outer_0001', tenantId: 'tenant_outer' });
      expect(getContext()?.userId).toBeUndefined();
    });
  });

  it('[NFR-OBS-01] returns snapshots and refuses writes without a context', () => {
    expect(getContext()).toBeUndefined();
    expect(setContextValue('tenantId', 'tenant_a')).toBe(false);
    runWithContext({ requestId: 'req_snapshot_01' }, () => {
      const snapshot = getContext() as { requestId: string };
      snapshot.requestId = 'tampered';
      expect(getRequestId()).toBe('req_snapshot_01');
    });
  });

  it('[NFR-SEC-06] validates context fields: hostile values are dropped, not stored or logged', () => {
    runWithContext({ requestId: 'req_validate_01', tenantId: 'tenant_ok' }, () => {
      expect(setContextValue('tenantId', 'tenant\nINJECTED')).toBe(false);
      expect(setContextValue('userId', '<script>')).toBe(false);
      expect(setContextValue('traceId', 'not-a-trace-id')).toBe(false);
      expect(setContextValue('spanId', '0'.repeat(16))).toBe(false);
      expect(getContext()?.tenantId).toBe('tenant_ok');
      expect(setContextValue('tenantId', undefined)).toBe(true);
      expect(getContext()?.tenantId).toBeUndefined();
    });
    runWithContext({ requestId: 'req_init_valid1', traceId: 'zz', tenantId: 'bad tenant' }, () => {
      expect(getContext()).toEqual({ requestId: 'req_init_valid1' });
    });
  });

  it('[NFR-OBS-01] generates a request id when none exists, using the injected generator', () => {
    runWithContext({}, () => expect(getRequestId()).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/), {});
    runWithContext({}, () => expect(getRequestId()).toBe('req_fixed_0001'), {
      generateRequestId: () => 'req_fixed_0001',
    });
  });
});

describe('request ids', () => {
  it('[NFR-OBS-01] generates schema-valid ids and supports an injected generator', () => {
    const id = newRequestId();
    expect(id).toMatch(/^req_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(IdSchema.safeParse(id).success).toBe(true);
    expect(newRequestId(() => 'req_injected_01')).toBe('req_injected_01');
    expect(() => newRequestId(() => 'bad id\r\n')).toThrow(TypeError);
  });

  it('[NFR-OBS-01] is deterministic and time-sortable with injected clock and randomness', () => {
    const make = (now: number) =>
      createIdGenerator('req', { now: () => now, randomBytes: seededBytes(5) })();
    expect(make(1_700_000_000_000)).toBe(make(1_700_000_000_000));
    expect(make(1_700_000_000_000) < make(1_700_000_001_000)).toBe(true);
    expect(() => createIdGenerator('Bad Prefix')).toThrow(TypeError);
  });

  const accepted = [
    '7b1c1f2e-5d3a-4c9b-8f10-2a6d9e4b5c31',
    '01HZX8Y9ABCDEFGHJKMNPQRSTV',
    'req_01HZX8Y9ABCDEFGHJKMNPQRSTV',
    'abcdefgh',
    `a${'b'.repeat(63)}`,
    'trace:1234.5678_abcd-efgh',
  ];
  const rejected: [string, unknown][] = [
    ['empty', ''],
    ['too short', 'abcdefg'],
    ['too long', `a${'b'.repeat(64)}`],
    ['CRLF header injection', 'abcdefgh\r\nX-Injected: 1'],
    ['LF only', 'abcdefgh\nnext'],
    ['space', 'abcd efgh'],
    ['double quote', 'abcd"efgh'],
    ['single quote', "abcd'efgh"],
    ['script tag', '<script>alert(1)</script>'],
    ['template injection', '{{7*7}}abcdefgh'],
    ['percent-encoded CRLF', 'abcdefgh%0d%0a'],
    ['path traversal', '../../etc/passwd'],
    ['backslash', 'abcd\\efgh'],
    ['semicolon', 'abcd;efgh12'],
    ['unicode letters', 'abcdéfgh12'],
    ['null byte', 'abcdefgh\u0000'],
    ['leading dash', '-abcdefgh'],
    ['leading dot', '.abcdefgh'],
    ['repeated headers (array)', ['abcdefgh', 'ijklmnop']],
    ['number', 12345678],
    ['undefined', undefined],
    ['object', { id: 'abcdefgh' }],
  ];

  it.each(accepted.map((value) => [value] as const))('[NFR-SEC-06] accepts %s', (value) => {
    expect(acceptRequestId(value)).toBe(value);
    expect(resolveRequestId(value, () => 'req_generated_1')).toEqual({
      requestId: value,
      source: 'header',
    });
  });

  it.each(rejected)('[NFR-SEC-06] rejects %s', (_name, value) => {
    expect(acceptRequestId(value)).toBeUndefined();
    expect(resolveRequestId(value, () => 'req_generated_1')).toEqual({
      requestId: 'req_generated_1',
      source: 'generated',
    });
  });
});

describe('traceparent', () => {
  it('[NFR-OBS-01] parses a valid header and round-trips through formatTraceparent', () => {
    expect(parseTraceparent(VALID_TRACEPARENT)).toEqual({
      version: '00',
      traceId: TRACE_ID,
      parentId: PARENT_ID,
      traceFlags: '01',
      sampled: true,
    });
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-00`)?.sampled).toBe(false);
    expect(formatTraceparent({ traceId: TRACE_ID, spanId: PARENT_ID })).toBe(VALID_TRACEPARENT);
    expect(formatTraceparent({ traceId: TRACE_ID, spanId: PARENT_ID, sampled: false })).toBe(
      `00-${TRACE_ID}-${PARENT_ID}-00`,
    );
    expect(formatTraceparent({ traceId: TRACE_ID, spanId: PARENT_ID, traceFlags: '03' })).toBe(
      `00-${TRACE_ID}-${PARENT_ID}-03`,
    );
  });

  it('[NFR-OBS-01] accepts future versions, ignoring their extension fields', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01`)?.version).toBe('01');
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01-extra-data`)?.traceId).toBe(TRACE_ID);
  });

  const invalid: [string, unknown][] = [
    ['upper-case trace id', `00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`],
    ['upper-case parent id', `00-${TRACE_ID}-${PARENT_ID.toUpperCase()}-01`],
    ['upper-case flags', `00-${TRACE_ID}-${PARENT_ID}-0A`],
    ['upper-case version', `0A-${TRACE_ID}-${PARENT_ID}-01`],
    ['version ff', `ff-${TRACE_ID}-${PARENT_ID}-01`],
    ['all-zero trace id', `00-${'0'.repeat(32)}-${PARENT_ID}-01`],
    ['all-zero parent id', `00-${TRACE_ID}-${'0'.repeat(16)}-01`],
    ['short trace id', `00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`],
    ['long trace id', `00-${TRACE_ID}0-${PARENT_ID}-01`],
    ['non-hex trace id', `00-${'g'.repeat(32)}-${PARENT_ID}-01`],
    ['non-hex flags', `00-${TRACE_ID}-${PARENT_ID}-zz`],
    ['wrong separators', `00_${TRACE_ID}_${PARENT_ID}_01`],
    ['trailing data on version 00', `00-${TRACE_ID}-${PARENT_ID}-01-extra`],
    ['future version with glued extension', `01-${TRACE_ID}-${PARENT_ID}-01x`],
    ['leading space', ` ${VALID_TRACEPARENT}`],
    ['trailing space', `${VALID_TRACEPARENT} `],
    ['CRLF injection', `${VALID_TRACEPARENT}\r\nX-Injected: 1`],
    ['trailing newline', `${VALID_TRACEPARENT}\n`],
    ['null byte', `${VALID_TRACEPARENT}\u0000`],
    ['full-width digits', `00-${'４'.repeat(32)}-${PARENT_ID}-01`],
    ['empty', ''],
    ['too short', '00-abc-def-01'],
    ['array', [VALID_TRACEPARENT]],
    ['number', 123],
    ['null', null],
    ['undefined', undefined],
    ['object', { traceparent: VALID_TRACEPARENT }],
  ];

  it.each(invalid)('[NFR-SEC-06] rejects %s', (_name, value) => {
    expect(parseTraceparent(value)).toBeNull();
    expect(isValidTraceparent(value)).toBe(false);
  });

  it('[NFR-SEC-06] rejects a megabyte of input without scanning it', () => {
    const started = performance.now();
    expect(parseTraceparent(`00-${'a'.repeat(1_000_000)}`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(250);
  });

  it('[NFR-OBS-01] refuses to format invalid ids', () => {
    expect(() => formatTraceparent({ traceId: 'x', spanId: PARENT_ID })).toThrow(TypeError);
    expect(() => formatTraceparent({ traceId: TRACE_ID, spanId: '0'.repeat(16) })).toThrow(
      TypeError,
    );
    expect(() =>
      formatTraceparent({ traceId: TRACE_ID, spanId: PARENT_ID, traceFlags: '1' }),
    ).toThrow(TypeError);
  });

  it('[NFR-OBS-01] generates deterministic, valid and never all-zero ids', () => {
    expect(generateTraceId(seededBytes(9))).toBe(generateTraceId(seededBytes(9)));
    expect(generateTraceId(seededBytes(9))).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSpanId(seededBytes(9))).toMatch(/^[0-9a-f]{16}$/);
    expect(generateTraceId((size) => new Uint8Array(size))).toBe(`${'0'.repeat(31)}1`);
    expect(generateSpanId((size) => new Uint8Array(size))).toBe(`${'0'.repeat(15)}1`);
    expect(() => generateTraceId(() => new Uint8Array(2))).toThrow(RangeError);
  });
});

describe('tracestate', () => {
  it.each([
    ['vendor=value', 'vendor=value'],
    ['a=1, b=2 ,c=3', 'a=1,b=2,c=3'],
    ['tenant@vendor=opaque%20value', 'tenant@vendor=opaque%20value'],
  ])('[NFR-OBS-01] accepts %s', (input, expected) => {
    expect(sanitizeTracestate(input)).toBe(expected);
  });

  it.each([
    ['empty', ''],
    ['no equals', 'novalue'],
    ['empty value', 'a='],
    ['upper-case key', 'Vendor=1'],
    ['duplicate keys', 'a=1,a=2'],
    ['value with equals', 'a=b=c'],
    ['non-breaking space after the value', 'a=b\u00a0'],
    ['CRLF injection', 'a=1\r\nX-Injected: 1'],
    ['too many members', Array.from({ length: 33 }, (_u, i) => `k${i}=v`).join(',')],
    ['too long', `a=${'v'.repeat(600)}`],
    ['non-string', 42 as unknown as string],
  ])('[NFR-SEC-06] discards %s', (_name, input) => {
    expect(sanitizeTracestate(input)).toBeUndefined();
  });
});

describe('createRequestContext', () => {
  const deps = { generateRequestId: () => 'req_det_000001', randomBytes: seededBytes(3) };

  it('[NFR-OBS-01] starts a new trace when no trace headers arrive, deterministically', () => {
    const first = createRequestContext({ ...deps, randomBytes: seededBytes(3) });
    const second = createRequestContext({ ...deps, randomBytes: seededBytes(3) });
    expect(first).toEqual(second);
    expect(first).toMatchObject({ requestId: 'req_det_000001', traceFlags: '01' });
    expect(first.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(first.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(first).not.toHaveProperty('parentSpanId');
    expect(createRequestContext({ ...deps, sampled: false }).traceFlags).toBe('00');
  });

  it('[NFR-OBS-01] continues a valid inbound trace under a fresh span id and keeps tracestate', () => {
    const context = createRequestContext({
      ...deps,
      headers: {
        traceparent: VALID_TRACEPARENT,
        tracestate: 'vendor=value',
        'x-request-id': '7b1c1f2e-5d3a-4c9b-8f10-2a6d9e4b5c31',
      },
    });
    expect(context).toMatchObject({
      requestId: '7b1c1f2e-5d3a-4c9b-8f10-2a6d9e4b5c31',
      traceId: TRACE_ID,
      parentSpanId: PARENT_ID,
      traceFlags: '01',
      tracestate: 'vendor=value',
    });
    expect(context.spanId).not.toBe(PARENT_ID);
  });

  it('[NFR-SEC-06] ignores malformed, duplicated and hostile headers instead of echoing them', () => {
    const context = createRequestContext({
      ...deps,
      headers: {
        traceparent: ['00-bad', VALID_TRACEPARENT],
        tracestate: 'a=1',
        'x-request-id': 'bad id\r\nInjected: 1',
      },
    });
    expect(context.requestId).toBe('req_det_000001');
    expect(context.traceId).not.toBe(TRACE_ID);
    expect(context).not.toHaveProperty('tracestate');
    expect(JSON.stringify(context)).not.toContain('Injected');
  });

  it('[NFR-OBS-01] reads headers case-insensitively and ignores tracestate without a valid traceparent', () => {
    const upper = createRequestContext({
      ...deps,
      headers: { TraceParent: VALID_TRACEPARENT, 'X-Request-Id': 'abcdefgh12' },
    });
    expect(upper).toMatchObject({ traceId: TRACE_ID, requestId: 'abcdefgh12' });
    const orphan = createRequestContext({ ...deps, headers: { tracestate: 'a=1' } });
    expect(orphan).not.toHaveProperty('tracestate');
  });
});

describe('outgoing propagation', () => {
  it('[NFR-OBS-01] sends nothing outside a context', () => {
    expect(propagationHeaders()).toEqual({});
    expect(correlationResponseHeaders()).toEqual({});
  });

  it('[NFR-OBS-01] forwards the request id and a valid traceparent carrying our span as parent', () => {
    const context = createRequestContext({
      headers: { traceparent: VALID_TRACEPARENT, tracestate: 'vendor=value' },
      generateRequestId: () => 'req_prop_000001',
      randomBytes: seededBytes(11),
    });
    runWithContext(context, () => {
      const headers = propagationHeaders();
      expect(headers['x-request-id']).toBe('req_prop_000001');
      expect(parseTraceparent(headers.traceparent)).toMatchObject({
        traceId: TRACE_ID,
        parentId: context.spanId,
        traceFlags: '01',
      });
      expect(headers).not.toHaveProperty('tracestate');
      expect(headers).not.toHaveProperty('x-ms-client-request-id');
      expect(
        propagationHeaders({ includeTracestate: true, azureClientRequestId: true }),
      ).toMatchObject({
        tracestate: 'vendor=value',
        'x-ms-client-request-id': 'req_prop_000001',
      });
      expect(correlationResponseHeaders()).toEqual({ 'x-request-id': 'req_prop_000001' });
    });
  });

  it('[NFR-OBS-01] sends only the request id when the context has no trace', () => {
    runWithContext({ requestId: 'req_only_000001' }, () => {
      expect(propagationHeaders()).toEqual({ 'x-request-id': 'req_only_000001' });
    });
  });
});
