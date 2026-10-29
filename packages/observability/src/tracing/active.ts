import { isSpanContextValid, trace } from '@opentelemetry/api';

/** Ids of the active OpenTelemetry span. */
export interface ActiveTraceIds {
  readonly traceId: string;
  readonly spanId: string;
  /** Two lower-case hex digits, as in the W3C `traceparent` header. */
  readonly traceFlags: string;
  readonly traceState?: string;
}

/**
 * Ids of the OpenTelemetry span that is active right now, or `undefined` when no SDK is registered
 * (the API then hands out non-recording spans with an invalid context) or no span is active.
 */
export function getActiveTraceIds(): ActiveTraceIds | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const context = span.spanContext();
  if (!isSpanContextValid(context)) return undefined;
  const traceFlags = (context.traceFlags & 0xff).toString(16).padStart(2, '0');
  const traceState = context.traceState?.serialize();
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    traceFlags,
    ...(traceState ? { traceState } : {}),
  };
}
