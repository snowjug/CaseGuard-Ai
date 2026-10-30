import type { AzureMonitorOpenTelemetryOptions } from '@azure/monitor-opentelemetry';
import type { AppConfig, TelemetryConfig } from '@caseguard/config';
import {
  bindMetricsToOtel,
  safeErrorCode,
  type Logger,
  type OtelBinding,
  type ProductMetrics,
} from '@caseguard/observability';

/** The part of `@azure/monitor-opentelemetry` this API calls. */
export interface AzureMonitorDistro {
  useAzureMonitor(options?: AzureMonitorOpenTelemetryOptions): void;
  shutdownAzureMonitor(): Promise<void>;
}

export interface StartTelemetryOptions {
  readonly config: Pick<AppConfig, 'telemetry' | 'runtime'>;
  readonly logger: Pick<Logger, 'info' | 'warn'>;
  readonly metrics: Pick<ProductMetrics, 'registry' | 'recordError'>;
  /**
   * Loads the Azure Monitor distro. It is only called when a connection string is configured, so a
   * deployment without one never loads the SDK. Tests inject a fake.
   */
  readonly loadDistro?: () => Promise<AzureMonitorDistro>;
  /** Where the OpenTelemetry resource attributes are published for the SDK to read. Default: `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** How long `shutdown()` waits for the final flush before giving up. Default 5000. */
  readonly shutdownTimeoutMs?: number;
}

export interface Telemetry {
  /** True when an exporter was started. */
  readonly enabled: boolean;
  /** Flushes and stops the exporter, then unbinds the metrics mirror. Idempotent; never throws. */
  shutdown(): Promise<void>;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;
const RESOURCE_ATTRIBUTES_VARIABLE = 'OTEL_RESOURCE_ATTRIBUTES';
const SERVICE_NAME_VARIABLE = 'OTEL_SERVICE_NAME';
// The SDK discards the whole variable when one value is longer than 255 characters.
const MAX_ATTRIBUTE_LENGTH = 200;
/**
 * Statsbeat and SDK stats are Microsoft's own health telemetry about the exporter. They go to Microsoft,
 * not to the operator's workspace, and the exporter sends them unless told not to. Setting a connection
 * string is not a request for that, so they start off. The exporter treats any non-empty value as "off",
 * so an operator who wants them sets the variable to an empty string.
 */
const SDK_HEALTH_TELEMETRY_OFF = {
  APPLICATION_INSIGHTS_NO_STATSBEAT: 'true',
  APPLICATIONINSIGHTS_SDKSTATS_DISABLED: 'true',
} as const;

const DISABLED: Telemetry = { enabled: false, shutdown: () => Promise.resolve() };

const loadAzureMonitor = (): Promise<AzureMonitorDistro> => import('@azure/monitor-opentelemetry');

function attributeKey(entry: string): string {
  const raw = entry.split('=')[0]?.trim() ?? '';
  try {
    return decodeURIComponent(raw);
  } catch {
    // An undecodable key cannot equal ours, which is all this lookup needs to know.
    return raw;
  }
}

/**
 * Publishes the resource attributes through the variables every OpenTelemetry SDK reads
 * (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`). The distro merges them last, so they decide the
 * cloud role name and version Application Insights shows, which the distro's own `resource` option
 * cannot do without an OpenTelemetry resource object that this package may not import. Values an
 * operator already set win.
 */
export function applyResourceEnvironment(
  env: NodeJS.ProcessEnv,
  resource: {
    readonly serviceName: string;
    readonly version: string;
    readonly environment: string;
  },
): void {
  const existing = env[RESOURCE_ATTRIBUTES_VARIABLE]?.trim() ?? '';
  const present = new Set(existing === '' ? [] : existing.split(',').map(attributeKey));

  if (!present.has('service.name') && !env[SERVICE_NAME_VARIABLE]) {
    env[SERVICE_NAME_VARIABLE] = resource.serviceName;
  }
  const wanted: readonly (readonly [string, string])[] = [
    ['service.version', resource.version],
    ['deployment.environment', resource.environment],
  ];
  const additions = wanted
    .filter(([key]) => !present.has(key))
    .map(([key, value]) => `${key}=${encodeURIComponent(value.slice(0, MAX_ATTRIBUTE_LENGTH))}`);
  if (additions.length === 0) return;
  env[RESOURCE_ATTRIBUTES_VARIABLE] = [...(existing === '' ? [] : [existing]), ...additions].join(
    ',',
  );
}

/** Turns the exporter's own health telemetry off unless the operator set the variables (see `SDK_HEALTH_TELEMETRY_OFF`). */
export function applySdkHealthTelemetryDefaults(env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(SDK_HEALTH_TELEMETRY_OFF)) {
    if (env[name] === undefined) env[name] = value;
  }
}

/**
 * Everything switched off except request spans and metrics. The distro turns on HTTP, Azure SDK, database
 * and log instrumentation by default; those record full URLs with query strings, storage paths and SQL
 * text, so none of them runs. `tracesPerSecond: 0` is required for `samplingRatio` to apply at all (the
 * distro's default is a limit of five traces per second), and the live-metrics stream (on by default in
 * this version) and the offline retry files stay off.
 */
function distroOptions(
  telemetry: TelemetryConfig,
  connectionString: string,
): AzureMonitorOpenTelemetryOptions {
  return {
    azureMonitorExporterOptions: { connectionString, disableOfflineStorage: true },
    samplingRatio: telemetry.otelSamplingRatio,
    tracesPerSecond: 0,
    enableLiveMetrics: false,
    enableStandardMetrics: true,
    enablePerformanceCounters: false,
    enableTraceBasedSamplingForLogs: false,
    browserSdkLoaderOptions: { enabled: false },
    instrumentationOptions: {
      http: { enabled: false },
      azureSdk: { enabled: false },
      mongoDb: { enabled: false },
      mySql: { enabled: false },
      postgreSql: { enabled: false },
      redis: { enabled: false },
      redis4: { enabled: false },
      bunyan: { enabled: false },
      winston: { enabled: false },
      console: { enabled: false },
    },
  };
}

function invalidDistro(): Error {
  return Object.assign(
    new Error('The Azure Monitor distro does not export the expected functions'),
    {
      code: 'invalid_distro',
    },
  );
}

/** Waits for `work`, but no longer than `timeoutMs`. Resolves `'timeout'` instead of rejecting on delay. */
async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([work.then(() => 'done' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Starts the optional Azure Monitor / OpenTelemetry export. It is off unless
 * `APPLICATIONINSIGHTS_CONNECTION_STRING` is set (the distro is not even loaded then), and it can never
 * stop the API: any failure is counted, reported once without the exception message (which can echo
 * the connection string), and leaves telemetry disabled.
 *
 * What is exported: the request spans of `registerTracing` and the product metrics (the registry
 * mirrored through `bindMetricsToOtel`, so its label cardinality limits apply). Logs are not exported.
 */
export async function startTelemetry(options: StartTelemetryOptions): Promise<Telemetry> {
  const { config, logger, metrics } = options;
  const secret = config.telemetry.appInsightsConnectionString;
  if (secret === null) return DISABLED;

  let distro: AzureMonitorDistro;
  // Tells an operator whether the package is missing (`load`) or the SDK refused the settings (`start`).
  let phase: 'load' | 'start' = 'load';
  try {
    distro = await (options.loadDistro ?? loadAzureMonitor)();
    if (
      typeof distro.useAzureMonitor !== 'function' ||
      typeof distro.shutdownAzureMonitor !== 'function'
    ) {
      throw invalidDistro();
    }
    phase = 'start';
    applyResourceEnvironment(options.env ?? process.env, {
      serviceName: config.telemetry.otelServiceName,
      version: config.runtime.version,
      environment: config.runtime.env,
    });
    applySdkHealthTelemetryDefaults(options.env ?? process.env);
    distro.useAzureMonitor(distroOptions(config.telemetry, secret.reveal()));
  } catch (error) {
    metrics.recordError('telemetry', 'exporter_start_failed');
    logger.warn(
      { event: 'telemetry.exporter_start_failed', phase, code: safeErrorCode(error) },
      'telemetry export could not start; the API continues without it',
    );
    return DISABLED;
  }

  let binding: OtelBinding | undefined;
  try {
    binding = bindMetricsToOtel(metrics.registry);
  } catch (error) {
    metrics.recordError('telemetry', 'metrics_bind_failed');
    logger.warn(
      { event: 'telemetry.metrics_bind_failed', code: safeErrorCode(error) },
      'product metrics are not mirrored to OpenTelemetry; request spans are still exported',
    );
  }
  logger.info(
    {
      event: 'telemetry.started',
      exporter: 'azure-monitor',
      samplingRatio: config.telemetry.otelSamplingRatio,
      metricsMirrored: binding?.active === true,
    },
    'telemetry export started',
  );

  const timeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  let stopping: Promise<void> | undefined;

  const stop = async (): Promise<void> => {
    try {
      const outcome = await settleWithin((async () => distro.shutdownAzureMonitor())(), timeoutMs);
      if (outcome === 'timeout') {
        metrics.recordError('telemetry', 'shutdown_timeout');
        logger.warn(
          { event: 'telemetry.shutdown_timeout', timeoutMs },
          'telemetry flush did not finish in time; the last spans and metrics may be lost',
        );
      }
    } catch (error) {
      metrics.recordError('telemetry', 'shutdown_failed');
      logger.warn(
        { event: 'telemetry.shutdown_failed', code: safeErrorCode(error) },
        'telemetry flush failed; the last spans and metrics may be lost',
      );
    }
    // Unbind after the flush: the final export still collects the mirrored gauges.
    try {
      binding?.dispose();
    } catch (error) {
      metrics.recordError('telemetry', 'shutdown_failed');
      logger.warn(
        { event: 'telemetry.shutdown_failed', code: safeErrorCode(error) },
        'telemetry metrics mirror could not be unbound',
      );
    }
  };

  return {
    enabled: true,
    shutdown: () => (stopping ??= stop()),
  };
}
