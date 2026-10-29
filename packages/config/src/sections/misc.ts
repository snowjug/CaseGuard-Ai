import type { BuildContext } from '../context';
import { Secret } from '../secret';
import type { DemoConfig, LimitsConfig, TelemetryConfig } from '../types';

export function buildLimitsConfig(ctx: BuildContext): LimitsConfig {
  const { raw } = ctx;
  const rateLimitMax = raw.RATE_LIMIT_MAX ?? 300;
  const rateLimitAiMax = raw.RATE_LIMIT_AI_MAX ?? 30;
  const malwareScanMode = raw.MALWARE_SCAN_MODE ?? 'none';

  if (rateLimitAiMax > rateLimitMax) {
    ctx.warn('RATE_LIMIT_AI_MAX is higher than RATE_LIMIT_MAX, so it has no effect.');
  }
  if (ctx.production && malwareScanMode === 'eicar-test') {
    ctx.fail(
      'MALWARE_SCAN_MODE',
      "'eicar-test' is a test hook and cannot be used when APP_ENV=production",
    );
  }
  return {
    rateLimitMax,
    rateLimitWindowMs: raw.RATE_LIMIT_WINDOW_MS ?? 60_000,
    rateLimitAiMax,
    malwareScanMode,
  };
}

export function buildTelemetry(ctx: BuildContext, serviceName: string): TelemetryConfig {
  const { raw } = ctx;
  const connection = raw.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (connection !== undefined && !/InstrumentationKey=/i.test(connection)) {
    ctx.fail(
      'APPLICATIONINSIGHTS_CONNECTION_STRING',
      "must be an Application Insights connection string ('InstrumentationKey=...;IngestionEndpoint=...')",
    );
  }
  return {
    appInsightsConnectionString: connection === undefined ? null : new Secret(connection),
    otelServiceName: raw.OTEL_SERVICE_NAME ?? serviceName,
    otelSamplingRatio: raw.OTEL_SAMPLING_RATIO ?? 1,
  };
}

/** Demo routes and auto-seeding exist for synthetic data only, so production refuses them. */
export function buildDemo(ctx: BuildContext): DemoConfig {
  const { raw } = ctx;
  const mode = raw.DEMO_MODE ?? ctx.localLike;
  const autoSeed = raw.DEMO_AUTO_SEED ?? (ctx.env === 'local' && mode);

  if (ctx.production && mode) ctx.fail('DEMO_MODE', 'must be false when APP_ENV=production');
  if (ctx.production && autoSeed)
    ctx.fail('DEMO_AUTO_SEED', 'must be false when APP_ENV=production');
  if (autoSeed && !mode) {
    ctx.fail('DEMO_AUTO_SEED', 'requires DEMO_MODE=true (seeding is part of demo mode)');
  }
  if (ctx.env === 'staging' && mode) {
    ctx.warn('DEMO_MODE is on in staging; the demo reset route can wipe case data.');
  }
  return { mode, autoSeed };
}
