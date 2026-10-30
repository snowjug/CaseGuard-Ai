import { ConfigError, describeConfig, loadConfig, type AppConfig } from '@caseguard/config';
import { buildApp } from './app';
import { createInfrastructure, knownTenantIds } from './container';
import { IDEMPOTENCY_PURGE_INTERVAL_MS, purgeExpiredIdempotency } from './maintenance';
import { createHandlers } from './routes';
import { autoSeedDemo } from './services/demo/auto-seed';
import { JOB_STALE_AFTER_MS } from './services/job-service';
import { startTelemetry } from './telemetry';
import packageJson from '../package.json';

/** How long shutdown waits for running jobs before giving up (Container Apps allows 30 s by default). */
const SHUTDOWN_GRACE_MS = 20_000;
/** How often a replica looks for jobs whose owner stopped responding. */
const ORPHAN_SWEEP_INTERVAL_MS = 30_000;
/** The longest the server waits for the telemetry exporter before it starts listening anyway. */
const TELEMETRY_START_WAIT_MS = 5_000;

function loadConfigOrExit(): AppConfig {
  try {
    return loadConfig(process.env, { defaultVersion: packageJson.version });
  } catch (error) {
    // The logger is not built yet: configuration problems are printed once, without any values.
    console.error(
      error instanceof ConfigError ? error.message : 'Configuration could not be loaded',
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const infra = await createInfrastructure(config);
  const { logger } = infra;

  // Optional export to Application Insights; off unless APPLICATIONINSIGHTS_CONNECTION_STRING is set, and a
  // failure here never stops start-up. It cannot run before `createInfrastructure`, which creates the
  // logger and the metrics registry it reports to. It starts now and is given a few seconds before the
  // server listens: loading the SDK can be slow on a cold disk, and that must not keep the container from
  // answering its start-up probe (requests that arrive before it is ready are simply not traced).
  const telemetryStarting = startTelemetry({ config, logger, metrics: infra.metrics });

  for (const warning of config.warnings) logger.warn({ warning }, 'configuration warning');

  // A lone local process knows that nothing else runs its jobs, so whatever the last run left
  // unfinished is lost. Elsewhere other replicas (or the previous revision during a rollout) may be
  // running jobs right now: only jobs whose owner stopped sending heartbeats are orphaned, and a
  // periodic sweep catches the ones that were still fresh at start-up.
  const tenantIds = knownTenantIds(config);
  const recovery = config.runtime.localLike ? {} : { staleAfterMs: JOB_STALE_AFTER_MS };
  const sweepOrphans = async (): Promise<void> => {
    const recovered = await infra.services.jobs.recoverOrphans(tenantIds, recovery);
    if (recovered > 0) logger.warn({ recovered }, 'marked jobs that lost their server as failed');
  };
  await sweepOrphans();
  const sweeper = config.runtime.localLike
    ? null
    : setInterval(() => {
        sweepOrphans().catch((error: unknown) =>
          logger.error({ err: error }, 'could not sweep orphaned jobs'),
        );
      }, ORPHAN_SWEEP_INTERVAL_MS);
  sweeper?.unref();

  // Expired idempotency keys are removed whenever a tenant reserves a new one; this catches the
  // tenants that went quiet. It runs everywhere, including local runs.
  const purgeIdempotency = async (): Promise<void> => {
    const purged = await purgeExpiredIdempotency(infra, tenantIds);
    if (purged > 0) logger.info({ purged }, 'removed expired idempotency keys');
  };
  await purgeIdempotency();
  const purger = setInterval(() => {
    purgeIdempotency().catch((error: unknown) =>
      logger.error({ err: error }, 'could not purge idempotency keys'),
    );
  }, IDEMPOTENCY_PURGE_INTERVAL_MS);
  purger.unref();
  const app = await buildApp({ infra, handlers: createHandlers(infra) });

  // A bug that escapes every handler must not leave a half-working process behind: log it and let the
  // platform restart the container.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const deadline = setTimeout(() => {
      logger.error('shutdown grace period exceeded; exiting');
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    deadline.unref();
    if (sweeper !== null) clearInterval(sweeper);
    clearInterval(purger);
    try {
      await app.close();
      // Flush spans and metrics while the process is still whole; bounded, and it never throws.
      await (await telemetryStarting).shutdown();
      await infra.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // Demo data is seeded after migrations and before the first request; a failure is logged and the
  // server still starts (the next start, or `pnpm demo:seed`, resumes where it stopped).
  if (config.demo.autoSeed) await autoSeedDemo(infra);

  // Give telemetry a few seconds to be ready for the first request, never longer (see above).
  await Promise.race([
    telemetryStarting,
    new Promise<void>((resolve) => setTimeout(resolve, TELEMETRY_START_WAIT_MS).unref()),
  ]);

  await app.listen({ host: config.http.host, port: config.http.port });
  logger.info(describeConfig(config), 'CaseGuard API started');
}

main().catch((error: unknown) => {
  console.error('Fatal start-up error:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
