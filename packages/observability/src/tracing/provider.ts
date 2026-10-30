import { trace, type Tracer, type TracerProvider } from '@opentelemetry/api';
import { INSTRUMENTATION_NAME } from './spans';

interface DelegatingTracerProvider extends TracerProvider {
  getDelegateTracer(name: string): Tracer | undefined;
}

// The API hands out a proxy provider that only gains a delegate once an SDK registers. `instanceof` is
// not used because the bundled API and the SDK's own copy are different classes that share one global.
function isDelegating(provider: TracerProvider): provider is DelegatingTracerProvider {
  return typeof (provider as Partial<DelegatingTracerProvider>).getDelegateTracer === 'function';
}

/**
 * The tracer of the registered OpenTelemetry SDK, or `undefined` while only the API's no-op provider
 * exists. Callers use it to skip every piece of span work when telemetry export is off. It is looked up
 * on every call on purpose: the Azure Monitor distro resets the global API state when it starts, so a
 * tracer obtained earlier would stay a no-op for good.
 */
export function getRegisteredTracer(name: string = INSTRUMENTATION_NAME): Tracer | undefined {
  const provider = trace.getTracerProvider();
  return isDelegating(provider) ? provider.getDelegateTracer(name) : provider.getTracer(name);
}

/** True once an OpenTelemetry tracer provider has been registered. */
export function hasTracerProvider(): boolean {
  return getRegisteredTracer() !== undefined;
}
