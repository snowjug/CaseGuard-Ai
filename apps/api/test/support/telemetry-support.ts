import type { AzureMonitorOpenTelemetryOptions } from '@azure/monitor-opentelemetry';
import { loadConfig, type AppConfig } from '@caseguard/config';
import {
  createLogger,
  createMetricsRegistry,
  createProductMetrics,
  type Logger,
  type ProductMetrics,
} from '@caseguard/observability';
import {
  installInMemoryTracing,
  installRecordingMeter,
  type InMemoryTracing,
  type InstalledMeter,
} from '@caseguard/observability/testing';
import type { AzureMonitorDistro } from '../../src/telemetry';

/** Pieces of a realistic connection string. Assembled at run time so no secret-shaped literal sits in the source. */
export const FAKE_INSTRUMENTATION_KEY = ['0a1b2c3d', '4e5f', '4a6b', '8c7d', '9e0f1a2b3c4d'].join(
  '-',
);
export const FAKE_INGESTION_HOST = 'ingest.fake-region.example.test';

export function fakeConnectionString(): string {
  return [
    ['InstrumentationKey', FAKE_INSTRUMENTATION_KEY].join('='),
    `IngestionEndpoint=https://${FAKE_INGESTION_HOST}/`,
    'LiveEndpoint=https://live.fake-region.example.test/',
  ].join(';');
}

/** What must never appear in any log line, error, metric or span. */
export function connectionStringFragments(): string[] {
  return [fakeConnectionString(), FAKE_INSTRUMENTATION_KEY, FAKE_INGESTION_HOST];
}

/** A validated configuration, as `main` would load it, with telemetry settings on top. */
export function telemetryConfig(env: Record<string, string> = {}): AppConfig {
  return loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: 'pglite://memory',
    LOG_LEVEL: 'debug',
    APP_VERSION: '1.2.3',
    ...env,
  });
}

export function enabledConfig(env: Record<string, string> = {}): AppConfig {
  return telemetryConfig({ APPLICATIONINSIGHTS_CONNECTION_STRING: fakeConnectionString(), ...env });
}

export interface Rig {
  readonly logger: Logger;
  readonly metrics: ProductMetrics;
  /** Every JSON log line written so far, raw. */
  lines(): string[];
  /** Parsed log lines. */
  events(): Record<string, unknown>[];
  /** Everything observable from outside: log output plus the rendered metrics. */
  output(): string;
  errorCount(component: string, code: string): number;
}

/** A real logger and metrics registry whose output the test can inspect. */
export function createRig(): Rig {
  const lines: string[] = [];
  const logger = createLogger({
    service: 'caseguard-api',
    version: '1.2.3',
    env: 'test',
    level: 'debug',
    destination: { write: (chunk: string) => void lines.push(chunk) },
  });
  const registry = createMetricsRegistry();
  const metrics = createProductMetrics(registry, { service: 'caseguard-api', version: '1.2.3' });
  const rawLines = (): string[] =>
    lines.flatMap((chunk) => chunk.split('\n')).filter((line) => line.trim() !== '');
  return {
    logger,
    metrics,
    lines: rawLines,
    events: () => rawLines().map((line) => JSON.parse(line) as Record<string, unknown>),
    output: () => `${rawLines().join('\n')}\n${registry.renderPrometheus()}`,
    errorCount(component, code) {
      const errors = registry
        .snapshot()
        .metrics.find((metric) => metric.name === 'caseguard_errors_total');
      if (errors === undefined || errors.type === 'histogram') return 0;
      return (
        errors.series.find(
          (series) => series.labels['component'] === component && series.labels['code'] === code,
        )?.value ?? 0
      );
    },
  };
}

export interface FakeDistroOptions {
  /** Thrown by `useAzureMonitor`, like an invalid connection string. */
  readonly failStart?: { readonly value: unknown };
  /** Thrown (or rejected) by `shutdownAzureMonitor`. */
  readonly failShutdown?: { readonly value: unknown; readonly sync?: boolean };
  /** `shutdownAzureMonitor` returns a promise that only settles through `settleShutdown`. */
  readonly hangShutdown?: boolean;
  /** The environment object handed to `startTelemetry`; the fake snapshots it when `useAzureMonitor` runs. */
  readonly env?: NodeJS.ProcessEnv;
}

export interface FakeDistro {
  readonly distro: AzureMonitorDistro;
  readonly useCalls: {
    readonly options: AzureMonitorOpenTelemetryOptions;
    readonly env: NodeJS.ProcessEnv;
  }[];
  /** Number of observable-gauge callbacks still attached when `shutdownAzureMonitor` was called. */
  readonly callbacksAtShutdown: number[];
  readonly shutdownCalls: () => number;
  readonly tracing: () => InMemoryTracing | undefined;
  readonly meter: () => InstalledMeter | undefined;
  settleShutdown(error?: { readonly value: unknown }): void;
  cleanup(): void;
}

/**
 * Stands in for `@azure/monitor-opentelemetry`: it records how it was called and, like the real distro,
 * registers a tracer provider and a meter provider as the OpenTelemetry globals. Nothing touches a network.
 */
export function createFakeDistro(options: FakeDistroOptions = {}): FakeDistro {
  const useCalls: FakeDistro['useCalls'] = [];
  const callbacksAtShutdown: number[] = [];
  let shutdownCalls = 0;
  let tracing: InMemoryTracing | undefined;
  let meter: InstalledMeter | undefined;
  let settle: (error?: { readonly value: unknown }) => void = () => undefined;

  const distro: AzureMonitorDistro = {
    useAzureMonitor(distroOptions) {
      useCalls.push({ options: distroOptions ?? {}, env: { ...options.env } });
      if (options.failStart !== undefined) throw options.failStart.value;
      tracing = installInMemoryTracing();
      meter = installRecordingMeter();
    },
    shutdownAzureMonitor() {
      shutdownCalls += 1;
      callbacksAtShutdown.push(
        meter?.instruments.reduce((total, instrument) => total + instrument.callbacks.length, 0) ??
          0,
      );
      if (options.failShutdown?.sync === true) throw options.failShutdown.value;
      if (options.failShutdown !== undefined) {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
        return Promise.reject(options.failShutdown.value);
      }
      if (options.hangShutdown === true) {
        return new Promise<void>((resolve, reject) => {
          settle = (error) => {
            if (error === undefined) resolve();
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
            else reject(error.value);
          };
        });
      }
      return Promise.resolve();
    },
  };

  return {
    distro,
    useCalls,
    callbacksAtShutdown,
    shutdownCalls: () => shutdownCalls,
    tracing: () => tracing,
    meter: () => meter,
    settleShutdown: (error) => settle(error),
    cleanup() {
      tracing?.uninstall();
      meter?.uninstall();
    },
  };
}
