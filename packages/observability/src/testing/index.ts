/**
 * Test doubles for OpenTelemetry: an in-memory tracer provider with an async context manager and a recording
 * meter, registered as the API globals the way the real SDK registers itself. Import from
 * `@caseguard/observability/testing`; the production entry point does not export any of this.
 */
export {
  AlsContextManager,
  InMemoryTracerProvider,
  installInMemoryTracing,
  RecordedSpan,
  type InMemoryTracerOptions,
  type InMemoryTracing,
  type InstallTracingOptions,
  type RecordedEvent,
} from './in-memory-tracing';
export {
  createRecordingMeter,
  installRecordingMeter,
  type CreatedInstrument,
  type InstalledMeter,
  type InstrumentCall,
  type RecordingMeter,
} from './recording-meter';
