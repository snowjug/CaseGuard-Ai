import {
  context,
  createTraceState,
  isSpanContextValid,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api';
import { CONTEXT_ID_PATTERN } from '../context/request-id';
import { setContextValue } from '../context/store';
import { parseTraceparent, sanitizeTracestate } from '../context/w3c';
import { createScrubber, type Scrubber } from '../redaction/scrubber';
import { sanitizeSpanAttributes, type SpanAttributeLimits } from './attributes';
import { getRegisteredTracer } from './provider';
import { recordSpanError } from './spans';

/**
 * The only attribute names a server span ever carries. Identifiers of tenants, users and cases,
 * headers, bodies and URLs are not on the list, so there is nothing to forget to strip.
 */
export const SERVER_SPAN_ATTRIBUTES = Object.freeze({
  method: 'http.request.method',
  route: 'http.route',
  statusCode: 'http.response.status_code',
  requestId: 'cg.request_id',
  routeId: 'cg.route_id',
} as const);

/** Name part used when no route matched (a 404): a constant, so scanners cannot mint span names. */
export const UNMATCHED_ROUTE = 'unmatched';

const MAX_SPAN_NAME_LENGTH = 128;
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'TRACE',
]);
// Printable ASCII after the leading slash: a route pattern has parameter names, never a query or fragment.
const ROUTE_PATTERN = /^\/[!-~]{0,199}$/;
const ROUTE_ID = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

// Spans leave the process, so errors recorded on them never carry stacks.
const DEFAULT_SCRUBBER: Scrubber = createScrubber({ includeStack: false });

/** What describes one inbound request. There is deliberately no URL field. */
export interface ServerSpanInput {
  /** HTTP verb as received; anything outside the standard set is reported as `_OTHER`. */
  readonly method: string;
  /** Route pattern with parameter names, such as `/api/v1/cases/:caseId`; undefined when no route matched. */
  readonly route?: string | undefined;
  /** Stable route identifier from the route registry, such as `cases.create`. */
  readonly routeId?: string | undefined;
  readonly requestId?: string | undefined;
  /** Raw inbound header values. They are validated here, so callers may pass them untrusted. */
  readonly traceparent?: unknown;
  readonly tracestate?: unknown;
}

/** Options for `startServerSpan`. */
export interface ServerSpanOptions {
  /** Tracer to use instead of the registered one (tests inject a recording tracer). */
  readonly tracer?: Tracer;
  readonly scrubber?: Scrubber;
  readonly limits?: SpanAttributeLimits;
}

/** The server span of one request. */
export interface ServerSpan {
  readonly traceId: string;
  readonly spanId: string;
  /** False when the SDK sampled the request out: the ids still propagate, no attribute work is done. */
  readonly recording: boolean;
  /** Runs `fn` with this span active, so child spans, outgoing calls and log lines belong to it. */
  run<T>(fn: () => T): T;
  /** Remembers the error that failed the request; it is recorded on the span only if the request ends 5xx. */
  captureError(error: unknown): void;
  /**
   * Ends the span once; later calls do nothing. Without a status code the request ended with no
   * response (the client aborted), so no status is recorded.
   */
  end(statusCode?: number): void;
}

function normalizeMethod(method: string): string {
  const upper = method.toUpperCase();
  return KNOWN_METHODS.has(upper) ? upper : '_OTHER';
}

function validRoute(route: string | undefined): string | undefined {
  if (route === undefined || !ROUTE_PATTERN.test(route)) return undefined;
  return route.includes('?') || route.includes('#') ? undefined : route;
}

function validRouteId(routeId: string | undefined): string | undefined {
  return routeId !== undefined && ROUTE_ID.test(routeId) ? routeId : undefined;
}

function validRequestId(requestId: string | undefined): string | undefined {
  return requestId !== undefined && CONTEXT_ID_PATTERN.test(requestId) ? requestId : undefined;
}

function validStatusCode(statusCode: number | undefined): number | undefined {
  return statusCode !== undefined &&
    Number.isInteger(statusCode) &&
    statusCode >= 100 &&
    statusCode <= 599
    ? statusCode
    : undefined;
}

/**
 * The context the new span starts from. A span that another instrumentation already made active owns
 * the request. Otherwise a well-formed inbound `traceparent` becomes the remote parent (our own strict
 * parser, so a hostile header can only ever be ignored), and failing that the span starts a new trace.
 */
function parentContext(input: ServerSpanInput): Context {
  const active = context.active();
  const activeSpanContext = trace.getSpanContext(active);
  if (activeSpanContext !== undefined && isSpanContextValid(activeSpanContext)) return active;

  const inbound = parseTraceparent(input.traceparent);
  if (inbound === null) return active;
  const tracestate = sanitizeTracestate(input.tracestate);
  const remote: SpanContext = {
    traceId: inbound.traceId,
    spanId: inbound.parentId,
    traceFlags: Number.parseInt(inbound.traceFlags, 16),
    isRemote: true,
    ...(tracestate === undefined ? {} : { traceState: createTraceState(tracestate) }),
  };
  return trace.setSpanContext(active, remote);
}

function finishRecording(
  span: Span,
  statusCode: number | undefined,
  failure: { readonly error: unknown } | undefined,
  scrubber: Scrubber,
): void {
  const code = validStatusCode(statusCode);
  if (code === undefined) return;
  span.setAttribute(SERVER_SPAN_ATTRIBUTES.statusCode, code);
  if (code < 500) return;
  if (failure === undefined) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${code}` });
  } else {
    recordSpanError(span, failure.error, { scrubber });
  }
}

/**
 * Starts the SERVER span of an inbound HTTP request, or returns `undefined` (doing no work at all)
 * while no OpenTelemetry SDK is registered, which is whenever telemetry export is off.
 *
 * The span is named `<METHOD> <routeId | route pattern | unmatched>` and carries only the attributes
 * of `SERVER_SPAN_ATTRIBUTES`. The ids of the new span are also written to the request context, so log
 * lines and outgoing `traceparent` headers match the exported trace even when the SDK has no context
 * manager that could make the span active.
 */
export function startServerSpan(
  input: ServerSpanInput,
  options: ServerSpanOptions = {},
): ServerSpan | undefined {
  const tracer = options.tracer ?? getRegisteredTracer();
  if (tracer === undefined) return undefined;

  const scrubber = options.scrubber ?? DEFAULT_SCRUBBER;
  const method = normalizeMethod(input.method);
  const route = validRoute(input.route);
  const routeId = validRouteId(input.routeId);
  const requestId = validRequestId(input.requestId);

  const attributes = sanitizeSpanAttributes(
    {
      [SERVER_SPAN_ATTRIBUTES.method]: method,
      [SERVER_SPAN_ATTRIBUTES.route]: route,
      [SERVER_SPAN_ATTRIBUTES.routeId]: routeId,
      [SERVER_SPAN_ATTRIBUTES.requestId]: requestId,
    },
    scrubber,
    options.limits,
  );
  const name = scrubber.text(
    `${method} ${routeId ?? route ?? UNMATCHED_ROUTE}`,
    MAX_SPAN_NAME_LENGTH,
  );
  const parent = parentContext(input);
  const span = tracer.startSpan(name, { kind: SpanKind.SERVER, attributes }, parent);

  const spanContext = span.spanContext();
  if (!isSpanContextValid(spanContext)) {
    span.end();
    return undefined;
  }
  setContextValue('traceId', spanContext.traceId);
  setContextValue('spanId', spanContext.spanId);
  setContextValue('traceFlags', (spanContext.traceFlags & 0xff).toString(16).padStart(2, '0'));

  const active = trace.setSpan(parent, span);
  const recording = span.isRecording();
  let ended = false;
  let failure: { readonly error: unknown } | undefined;

  return {
    traceId: spanContext.traceId,
    spanId: spanContext.spanId,
    recording,
    run: (fn) => context.with(active, fn),
    captureError(error) {
      if (!ended) failure = { error };
    },
    end(statusCode) {
      if (ended) return;
      ended = true;
      if (recording) finishRecording(span, statusCode, failure, scrubber);
      span.end();
    },
  };
}
