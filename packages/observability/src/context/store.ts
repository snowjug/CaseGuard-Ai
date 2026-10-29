import { AsyncLocalStorage } from 'node:async_hooks';
import { getActiveTraceIds } from '../tracing/active';
import { CONTEXT_ID_PATTERN, newRequestId } from './request-id';
import { isValidSpanId, isValidTraceFlags, isValidTraceId, sanitizeTracestate } from './w3c';

/** Correlation data that follows a request across awaits, timers and event-emitter callbacks. */
export interface RequestContext {
  requestId: string;
  traceId?: string;
  /** Span id of the server-side span for this request (our own, when no OpenTelemetry SDK runs). */
  spanId?: string;
  /** Caller's span id from an inbound `traceparent`. */
  parentSpanId?: string;
  /** Two hex digits; `01` means sampled. */
  traceFlags?: string;
  tracestate?: string;
  tenantId?: string;
  userId?: string;
}

/** Keys that may change after the context was created (for example once the caller is authenticated). */
export type MutableContextKey =
  'tenantId' | 'userId' | 'traceId' | 'spanId' | 'traceFlags' | 'tracestate';

/** The fields merged into every log line. */
export interface ContextLogFields {
  requestId?: string;
  traceId?: string;
  spanId?: string;
  tenantId?: string;
  userId?: string;
}

// The only module-level state: AsyncLocalStorage holds nothing outside an active `run` scope.
const storage = new AsyncLocalStorage<RequestContext>();

type FieldValidator = (value: string) => boolean;

const FIELD_VALIDATORS: Record<keyof RequestContext, FieldValidator> = {
  requestId: (value) => CONTEXT_ID_PATTERN.test(value),
  tenantId: (value) => CONTEXT_ID_PATTERN.test(value),
  userId: (value) => CONTEXT_ID_PATTERN.test(value),
  traceId: isValidTraceId,
  spanId: isValidSpanId,
  parentSpanId: isValidSpanId,
  traceFlags: isValidTraceFlags,
  tracestate: (value) => sanitizeTracestate(value) !== undefined,
};

/** Keeps only well-formed string fields so nothing hostile can reach log lines or outgoing headers. */
function sanitizeFields(input: Partial<RequestContext>): Partial<RequestContext> {
  const clean: Partial<RequestContext> = {};
  for (const key of Object.keys(FIELD_VALIDATORS) as (keyof RequestContext)[]) {
    const value = input[key];
    if (typeof value === 'string' && FIELD_VALIDATORS[key](value)) clean[key] = value;
  }
  return clean;
}

/** Options for `runWithContext`. */
export interface RunWithContextOptions {
  /** Used when neither the parent context nor `init` carries a request id. */
  readonly generateRequestId?: () => string;
}

/**
 * Runs `fn` inside a correlation context. Fields of `init` are validated (invalid ones are dropped),
 * layered over the enclosing context, and a request id is generated when none exists. The context is
 * private to this run, so parallel requests never see each other's values.
 */
export function runWithContext<T>(
  init: Partial<RequestContext>,
  fn: () => T,
  options: RunWithContextOptions = {},
): T {
  const merged = { ...storage.getStore(), ...sanitizeFields(init) };
  const store: RequestContext = {
    ...merged,
    requestId: merged.requestId ?? newRequestId(options.generateRequestId),
  };
  return storage.run(store, fn);
}

/** Snapshot of the current context, or `undefined` outside `runWithContext`. */
export function getContext(): Readonly<RequestContext> | undefined {
  const store = storage.getStore();
  return store === undefined ? undefined : { ...store };
}

/**
 * Sets (or clears, with `undefined`) one field on the current context. Returns `false` when there
 * is no context or the value is malformed, so callers can tell nothing was recorded.
 */
export function setContextValue(key: MutableContextKey, value: string | undefined): boolean {
  const store = storage.getStore();
  if (store === undefined) return false;
  if (value === undefined) {
    store[key] = undefined;
    return true;
  }
  if (!FIELD_VALIDATORS[key](value)) return false;
  store[key] = value;
  return true;
}

/** Current request id, if any. Handy as the `correlationId` of audit events. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/**
 * Fields for log correlation. When an OpenTelemetry span is active its ids win, so logs line up with
 * exported traces; otherwise the ids parsed from `traceparent` (or generated) are used.
 */
export function getContextLogFields(): ContextLogFields {
  const store = storage.getStore();
  const active = getActiveTraceIds();
  const fields: ContextLogFields = {};
  if (store?.requestId !== undefined) fields.requestId = store.requestId;
  const traceId = active?.traceId ?? store?.traceId;
  if (traceId !== undefined) fields.traceId = traceId;
  const spanId = active?.spanId ?? store?.spanId;
  if (spanId !== undefined) fields.spanId = spanId;
  if (store?.tenantId !== undefined) fields.tenantId = store.tenantId;
  if (store?.userId !== undefined) fields.userId = store.userId;
  return fields;
}
