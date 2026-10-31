import { redactSecretsInText, type AppConfig } from '@caseguard/config';
import {
  HealthRegistry,
  createLogger,
  createMetricsRegistry,
  createProductMetrics,
  type LogDestination,
} from '@caseguard/observability';
import { createAuthenticator } from '@caseguard/security';
import {
  DEV_PERSONAS,
  createDatabase,
  createIdGenerator,
  createRepositories,
  getMigrationStatus,
  migrate,
  seedFoundation,
  type Database,
  type Repositories,
} from './db';
import { createIdentityResolver } from './identity-sync';
import type { BaseInfrastructure, Infrastructure } from './infrastructure';
import { createServices } from './services';
import type { Services } from './services/ports';
import { createObjectStore, type ObjectStore } from './storage';

export interface InfrastructureOptions {
  readonly now?: () => Date;
  readonly newId?: (prefix: string) => string;
  /** Where log lines go (default: stdout). Tests capture them here. */
  readonly logDestination?: LogDestination;
  /** A ready (migrated, seeded) database. When given, the container does not open or close one. */
  readonly database?: Database;
  readonly objects?: ObjectStore;
  /** Replaces individual services (tests inject fakes for the ports they do not exercise). */
  readonly services?: Partial<Services>;
}

export interface Container extends Infrastructure {
  /** Stops background work and closes the database (if the container opened it). */
  close(): Promise<void>;
}

/** Tenants whose jobs may need recovering at start-up. */
export function knownTenantIds(config: AppConfig): string[] {
  const ids = new Set<string>();
  if (config.auth.mode === 'dev') for (const persona of DEV_PERSONAS) ids.add(persona.tenantId);
  for (const tenantId of Object.values(config.auth.entra?.tenantMap ?? {})) ids.add(tenantId);
  return [...ids];
}

async function openDatabase(
  config: AppConfig,
  logger: BaseInfrastructure['logger'],
): Promise<Database> {
  return createDatabase({
    url: config.database.url.reveal(),
    auth: config.database.auth,
    poolMax: config.database.poolMax,
    applicationName: config.runtime.serviceName,
    logger: { warn: (message, fields) => logger.warn(fields ?? {}, message) },
  });
}

function registerHealthChecks(
  health: HealthRegistry,
  database: Database,
  objects: ObjectStore,
  config: AppConfig,
): void {
  health.registerStandard(
    'database',
    async () => {
      const result = await database.ping();
      if (!result.ok) throw new Error(result.detail);
      return {
        detail:
          database.kind === 'pglite'
            ? 'pglite reachable: an in-process PostgreSQL-compatible engine for local development and tests, not the PostgreSQL service a deployment uses'
            : `${database.kind} reachable`,
      };
    },
    // PGlite is a stand-in for PostgreSQL, so the dependency says so like the local object store does.
    { simulated: database.kind === 'pglite' },
  );
  health.registerStandard('migrations', async () => {
    const status = await getMigrationStatus(database);
    if (status.checksumMismatch.length > 0) {
      return { status: 'down', detail: 'An applied migration changed after it ran' };
    }
    if (status.pending.length > 0) {
      return { status: 'down', detail: `${status.pending.length} migration(s) pending` };
    }
    return { detail: `up to date (${status.latest ?? 'none'})` };
  });
  health.registerStandard(
    'storage',
    async () => {
      const result = await objects.health();
      if (!result.ok) throw new Error(result.detail);
      return { detail: `${objects.kind} object store reachable` };
    },
    { simulated: objects.kind === 'local' },
  );
  // Stand-ins that need no network; services that call real providers replace these checks.
  health.registerStandard('search', () => ({ detail: 'lexical search runs in-process' }), {
    simulated: config.search.provider === 'lexical',
    enabled: config.search.provider === 'lexical',
  });
  health.registerStandard(
    'modelProvider',
    () => ({ detail: 'deterministic engine runs in-process' }),
    {
      simulated: config.ai.provider === 'deterministic',
      enabled: config.ai.provider === 'deterministic',
    },
  );
}

/**
 * The composition root: builds every process-wide dependency from validated configuration, in the one
 * order that works (logging and metrics, database and migrations, repositories, storage, identity,
 * services). Nothing else in the API constructs infrastructure.
 */
export async function createInfrastructure(
  config: AppConfig,
  options: InfrastructureOptions = {},
): Promise<Container> {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? createIdGenerator();

  const logger = createLogger({
    service: config.runtime.serviceName,
    version: config.runtime.version,
    env: config.runtime.env,
    level: config.logLevel,
    ...(config.runtime.gitCommit ? { commit: config.runtime.gitCommit } : {}),
    ...(options.logDestination ? { destination: options.logDestination } : {}),
    // Human-readable lines only for a developer's terminal; everything else (and any captured
    // destination) gets JSON, which is what log pipelines and tests parse.
    pretty: config.runtime.env === 'local' && options.logDestination === undefined,
    redact: redactSecretsInText,
  });
  const metricsRegistry = createMetricsRegistry();
  const metrics = createProductMetrics(metricsRegistry, {
    service: config.runtime.serviceName,
    version: config.runtime.version,
    ...(config.runtime.gitCommit ? { commit: config.runtime.gitCommit } : {}),
  });
  const health = new HealthRegistry({
    service: config.runtime.serviceName,
    version: config.runtime.version,
    commit: config.runtime.gitCommit,
    environment: config.runtime.env,
    onCheckError: (name, error) => logger.warn({ check: name, err: error }, 'health check failed'),
  });

  const ownsDatabase = options.database === undefined;
  const database = options.database ?? (await openDatabase(config, logger));
  try {
    if (ownsDatabase && config.database.autoMigrate) {
      const result = await migrate(database);
      if (result.appliedNow.length > 0) {
        logger.info({ applied: result.appliedNow }, 'database migrations applied');
      }
      // Synthetic tenants and personas exist only where synthetic data is the point of the environment.
      if (config.demo.mode || config.runtime.localLike) await seedFoundation(database, { now });
    }

    const repos: Repositories = createRepositories(database, { now, newId });
    const objects =
      options.objects ??
      (await createObjectStore(
        config.storage.provider === 'local'
          ? { provider: 'local', localDir: config.storage.localDir }
          : {
              provider: 'azure-blob',
              account: config.storage.account,
              container: config.storage.container,
            },
      ));

    registerHealthChecks(health, database, objects, config);

    const base: BaseInfrastructure = {
      config,
      logger,
      metricsRegistry,
      metrics,
      health,
      database,
      repos,
      objects,
      now,
      newId,
    };
    const services = createServices(base, options.services);

    const personaTenants = new Map(DEV_PERSONAS.map((persona) => [persona.id, persona.tenantId]));
    const authenticator = createAuthenticator(
      {
        mode: config.auth.mode,
        environment: config.runtime.env,
        devAuthEnabled: config.auth.devAuthEnabled,
        ...(config.auth.entra ? { entra: config.auth.entra } : {}),
      },
      {
        now,
        lookupPersona: async (personaId) => {
          const tenantId = personaTenants.get(personaId);
          if (tenantId === undefined) return null;
          const user = await repos
            .forTenant({ tenantId, actorId: 'system:auth' })
            .governance.getUser(personaId);
          return user === null
            ? null
            : {
                id: user.id,
                tenantId: user.tenantId,
                displayName: user.displayName,
                roles: user.roles,
                email: user.email,
                status: user.status,
              };
        },
        resolveUser: createIdentityResolver({ repos, now, logger }),
      },
    );

    return {
      ...base,
      authenticator,
      services,
      async close() {
        await services.jobs.idle();
        if (ownsDatabase) await database.close();
      },
    };
  } catch (error) {
    if (ownsDatabase) await database.close().catch(() => undefined);
    throw error;
  }
}
