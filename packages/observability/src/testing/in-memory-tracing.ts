import { AsyncLocalStorage } from 'node:async_hooks';
import {
  context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  TraceFlags,
  type Attributes,
  type AttributeValue,
  type Context,
  type ContextManager,
  type Exception,
  type Link,
  type Span,
  type SpanContext,
  type SpanKind,
  type SpanOptions,
  type SpanStatus,
  type TimeInput,
  type Tracer,
  type TracerProvider,
} from '@opentelemetry/api';

/** A span event as recorded by `RecordedSpan`. */
export interface RecordedEvent {
  readonly name: string;
  readonly attributes: Attributes;
}

function isAttributes(value: unknown): value is Attributes {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function exceptionAttributes(exception: Exception): Attributes {
  if (typeof exception === 'string') return { 'exception.message': exception };
  const attributes: Record<string, AttributeValue> = {};
  if ('name' in exception && typeof exception.name === 'string') {
    attributes['exception.type'] = exception.name;
  }
  if ('message' in exception && typeof exception.message === 'string') {
    attributes['exception.message'] = exception.message;
  }
  if (exception.stack !== undefined) attributes['exception.stacktrace'] = exception.stack;
  return attributes;
}

/** A span that keeps everything done to it, so tests can assert on names, attributes and status. */
export class RecordedSpan implements Span {
  readonly attributes: Record<string, AttributeValue> = {};
  readonly events: RecordedEvent[] = [];
  readonly exceptions: Exception[] = [];
  status: SpanStatus = { code: SpanStatusCode.UNSET };
  endCount = 0;

  constructor(
    public name: string,
    readonly kind: SpanKind | undefined,
    private readonly spanContextValue: SpanContext,
    readonly parentSpanId: string | undefined,
    readonly parentIsRemote: boolean,
    attributes: Attributes | undefined,
    private readonly onEnd?: (span: RecordedSpan) => void,
  ) {
    this.setAttributes(attributes ?? {});
  }

  get ended(): boolean {
    return this.endCount > 0;
  }

  spanContext(): SpanContext {
    return this.spanContextValue;
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Attributes): this {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) this.attributes[key] = value;
    }
    return this;
  }

  addEvent(name: string, attributesOrStartTime?: Attributes | TimeInput): this {
    this.events.push({
      name,
      attributes: isAttributes(attributesOrStartTime) ? attributesOrStartTime : {},
    });
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
    this.onEnd?.(this);
  }

  isRecording(): boolean {
    return !this.ended;
  }

  recordException(exception: Exception): void {
    this.exceptions.push(exception);
    this.events.push({ name: 'exception', attributes: exceptionAttributes(exception) });
  }
}

/** Options for the in-memory tracer. */
export interface InMemoryTracerOptions {
  /**
   * Decides whether a span is recorded. A span that is sampled out gets valid ids but records nothing,
   * the way an SDK sampler behaves. Default: record everything.
   */
  readonly sample?: (name: string, attributes: Attributes | undefined) => boolean;
  /** Called after each `end()`, like a span processor. A throwing callback propagates to the caller of `end()`. */
  readonly onEnd?: (span: RecordedSpan) => void;
}

type StartSpan = (name: string, options: SpanOptions | undefined, ctx: Context | undefined) => Span;

class InMemoryTracer implements Tracer {
  constructor(private readonly start: StartSpan) {}

  startSpan(name: string, options?: SpanOptions, ctx?: Context): Span {
    return this.start(name, options, ctx);
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
    const ctx = typeof second === 'function' ? undefined : second;
    const fn = (
      typeof first === 'function' ? first : typeof second === 'function' ? second : third
    ) as F;
    const span = this.start(name, options, ctx);
    return context.with(trace.setSpan(ctx ?? context.active(), span), () =>
      fn(span),
    ) as ReturnType<F>;
  }
}

function hexId(counter: number, length: number): string {
  return counter.toString(16).padStart(length, '0');
}

/** A tracer provider with deterministic ids that stores every span it starts. Implements only the API interfaces. */
export class InMemoryTracerProvider implements TracerProvider {
  /** Every recorded span, in start order. */
  readonly spans: RecordedSpan[] = [];
  /** Contexts of spans that were sampled out. */
  readonly unsampled: SpanContext[] = [];
  /** Names passed to `getTracer`, in call order. */
  readonly tracerNames: string[] = [];
  private traceCounter = 0;
  private spanCounter = 0;
  private readonly tracer: Tracer;

  constructor(private readonly options: InMemoryTracerOptions = {}) {
    this.tracer = new InMemoryTracer((name, spanOptions, ctx) =>
      this.start(name, spanOptions, ctx),
    );
  }

  getTracer(name: string): Tracer {
    this.tracerNames.push(name);
    return this.tracer;
  }

  /** Spans that were ended at least once. */
  get finished(): RecordedSpan[] {
    return this.spans.filter((span) => span.ended);
  }

  reset(): void {
    this.spans.length = 0;
    this.unsampled.length = 0;
    this.tracerNames.length = 0;
  }

  private start(
    name: string,
    spanOptions: SpanOptions | undefined,
    ctx: Context | undefined,
  ): Span {
    const parent =
      spanOptions?.root === true ? undefined : trace.getSpanContext(ctx ?? context.active());
    this.spanCounter += 1;
    let traceId = parent?.traceId;
    if (traceId === undefined) {
      this.traceCounter += 1;
      traceId = hexId(this.traceCounter, 32);
    }
    const sampled = this.options.sample?.(name, spanOptions?.attributes) ?? true;
    const spanContext: SpanContext = {
      traceId,
      spanId: hexId(this.spanCounter, 16),
      traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
    };
    if (!sampled) {
      this.unsampled.push(spanContext);
      return trace.wrapSpanContext(spanContext);
    }
    const span = new RecordedSpan(
      name,
      spanOptions?.kind,
      spanContext,
      parent?.spanId,
      parent?.isRemote === true,
      spanOptions?.attributes,
      this.options.onEnd,
    );
    this.spans.push(span);
    return span;
  }
}

/** Context manager backed by `AsyncLocalStorage`, like the one the real SDK registers. */
export class AlsContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  readonly with: ContextManager['with'] = (ctx, fn, thisArg, ...args) =>
    this.storage.run(ctx, () => fn.call(thisArg, ...args));

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  bind<T>(_ctx: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

/** Options for `installInMemoryTracing`. */
export interface InstallTracingOptions extends InMemoryTracerOptions {
  /** Register an async context manager so `trace.getActiveSpan()` works. Default true, as with the SDK. */
  readonly contextManager?: boolean;
}

/** Handle returned by `installInMemoryTracing`. */
export interface InMemoryTracing {
  readonly provider: InMemoryTracerProvider;
  readonly spans: RecordedSpan[];
  /** Removes the global tracer provider and context manager. Call it in `afterEach`. */
  uninstall(): void;
}

/**
 * Registers an in-memory tracer provider (and, by default, an async context manager) as the OpenTelemetry
 * globals, replacing whatever was registered. It stands in for the SDK in tests, so no network, exporter or
 * transitive SDK package is involved.
 */
export function installInMemoryTracing(options: InstallTracingOptions = {}): InMemoryTracing {
  trace.disable();
  context.disable();
  const provider = new InMemoryTracerProvider(options);
  if (options.contextManager !== false) context.setGlobalContextManager(new AlsContextManager());
  trace.setGlobalTracerProvider(provider);
  return {
    provider,
    spans: provider.spans,
    uninstall(): void {
      trace.disable();
      context.disable();
    },
  };
}
