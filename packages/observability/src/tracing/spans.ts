import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { createScrubber, type Scrubber } from '../redaction/scrubber';
import { sanitizeSpanAttributes, type SpanAttributeLimits } from './attributes';

/** Instrumentation scope reported for spans created through this package. */
export const INSTRUMENTATION_NAME = '@caseguard/observability';

const MAX_SPAN_NAME_LENGTH = 128;
const MAX_STATUS_MESSAGE_LENGTH = 200;
const FALLBACK_SPAN_NAME = 'span';

// Spans never carry stacks unless asked: exported traces leave the process boundary.
const scrubberWithoutStacks: Scrubber = createScrubber({ includeStack: false });
const scrubberWithStacks: Scrubber = createScrubber({ includeStack: true });

/** Options for `withSpan`. */
export interface SpanOptions {
  readonly kind?: SpanKind;
  /** Tracer to use instead of the global one (tests inject a recording tracer). */
  readonly tracer?: Tracer;
  /** Scrubber for attributes, names and errors. A custom one decides for itself whether stacks exist. */
  readonly scrubber?: Scrubber;
  readonly limits?: SpanAttributeLimits;
  /** Attach the scrubbed stack to the recorded exception event. Default false. */
  readonly recordStack?: boolean;
}

function resolveScrubber(options: Pick<SpanOptions, 'scrubber' | 'recordStack'>): Scrubber {
  return (
    options.scrubber ?? (options.recordStack === true ? scrubberWithStacks : scrubberWithoutStacks)
  );
}

function spanName(name: string, scrubber: Scrubber): string {
  const cleaned = scrubber.text(name.replace(/[\r\n\t]+/g, ' ').trim(), MAX_SPAN_NAME_LENGTH);
  return cleaned === '' ? FALLBACK_SPAN_NAME : cleaned;
}

/**
 * Records `error` on `span` (exception event and ERROR status) with a scrubbed message. Safe on
 * non-recording spans, so it is also a no-op when no OpenTelemetry SDK is registered.
 */
export function recordSpanError(
  span: Span,
  error: unknown,
  options: Pick<SpanOptions, 'scrubber' | 'recordStack'> = {},
): void {
  const scrubber = resolveScrubber(options);
  const serialized = scrubber.error(error);
  span.recordException({
    name: serialized.type,
    message: serialized.message,
    ...(options.recordStack === true && serialized.stack !== undefined
      ? { stack: serialized.stack }
      : {}),
  });
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: scrubber.text(serialized.message, MAX_STATUS_MESSAGE_LENGTH),
  });
}

/**
 * Runs `fn` inside an active span. Attributes are sanitised first (no PII, bounded size), failures
 * are recorded on the span and rethrown unchanged, and the span always ends. Without a registered
 * OpenTelemetry SDK the span is non-recording, so this only costs a function call.
 */
export async function withSpan<T>(
  name: string,
  attributes: Readonly<Record<string, unknown>> | undefined,
  fn: (span: Span) => Promise<T> | T,
  options: SpanOptions = {},
): Promise<T> {
  const scrubber = resolveScrubber(options);
  const tracer = options.tracer ?? trace.getTracer(INSTRUMENTATION_NAME);
  const safeAttributes: Attributes = sanitizeSpanAttributes(attributes, scrubber, options.limits);
  return tracer.startActiveSpan(
    spanName(name, scrubber),
    { kind: options.kind ?? SpanKind.INTERNAL, attributes: safeAttributes },
    async (span: Span): Promise<T> => {
      try {
        return await fn(span);
      } catch (error) {
        recordSpanError(span, error, options);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
