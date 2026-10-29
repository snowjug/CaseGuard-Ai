import { getActiveTraceIds } from '../tracing/active';
import { CLIENT_REQUEST_ID_HEADER, REQUEST_ID_HEADER } from './request-id';
import { getContext } from './store';
import {
  formatTraceparent,
  isValidSpanId,
  isValidTraceFlags,
  isValidTraceId,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
} from './w3c';

/** Options for `propagationHeaders`. */
export interface PropagationOptions {
  /** Forward `tracestate` as well. Default false: vendor state is only useful to the vendor. */
  readonly includeTracestate?: boolean;
  /** Also send `x-ms-client-request-id`, which Azure services echo into their own logs. Default false. */
  readonly azureClientRequestId?: boolean;
}

/**
 * Headers to attach to an outgoing call so the downstream service joins this trace and request:
 * `traceparent` (active OpenTelemetry span first, else the request context), `x-request-id` and,
 * on request, `tracestate` / `x-ms-client-request-id`. Empty outside any context.
 */
export function propagationHeaders(options: PropagationOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {};
  const context = getContext();
  const active = getActiveTraceIds();

  if (context !== undefined) {
    headers[REQUEST_ID_HEADER] = context.requestId;
    if (options.azureClientRequestId === true) {
      headers[CLIENT_REQUEST_ID_HEADER] = context.requestId;
    }
  }

  const traceId = active?.traceId ?? context?.traceId;
  const spanId = active?.spanId ?? context?.spanId;
  const flags = active?.traceFlags ?? context?.traceFlags ?? '01';
  if (
    traceId !== undefined &&
    spanId !== undefined &&
    isValidTraceId(traceId) &&
    isValidSpanId(spanId)
  ) {
    headers[TRACEPARENT_HEADER] = formatTraceparent({
      traceId,
      spanId,
      traceFlags: isValidTraceFlags(flags) ? flags : '01',
    });
    const traceState = active?.traceState ?? context?.tracestate;
    if (options.includeTracestate === true && traceState !== undefined) {
      headers[TRACESTATE_HEADER] = traceState;
    }
  }
  return headers;
}

/** Headers to echo on the response so clients can quote the request id in support tickets. */
export function correlationResponseHeaders(): Record<string, string> {
  const context = getContext();
  return context === undefined ? {} : { [REQUEST_ID_HEADER]: context.requestId };
}
