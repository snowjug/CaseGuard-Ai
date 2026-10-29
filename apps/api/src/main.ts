import { ConfigError, describeConfig, loadConfig, type AppConfig } from '@caseguard/config';
import { buildApp } from './app';
import { createInfrastructure, knownTenantIds } from './container';
import { createHandlers } from './routes';
import packageJson from '../package.json';

/** How long shutdown waits for running jobs before giving up (Container Apps allows 30 s by default). */
const SHUTDOWN_GRACE_MS = 20_000;

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

  for (const warning of config.warnings) logger.warn({ warning }, 'configuration warning');
  const recovered = await infra.services.jobs.recoverOrphans(knownTenantIds(config));
  if (recovered > 0)
    logger.warn({ recovered }, 'marked jobs interrupted by the last shutdown as failed');

  const app = await buildApp({ infra, handlers: createHandlers(infra) });

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
    try {
      await app.close();
      await infra.close();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.http.host, port: config.http.port });
  logger.info(describeConfig(config), 'CaseGuard API started');
}

main().catch((error: unknown) => {
  console.error('Fatal start-up error:', error instanceof Error ? error.message : 'unknown error');
  process.exit(1);
});
