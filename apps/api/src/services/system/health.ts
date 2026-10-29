import type { AiHealth } from '@caseguard/ai';
import type { AppConfig } from '@caseguard/config';
import type { HealthRegistry } from '@caseguard/observability';
import type { SystemHealth } from '@caseguard/schemas';
import type { Repositories } from '../../db';
import { reconcileDependencies } from './dependencies';
import { integrationNotices } from './notices';
import { unavailableProvider, withConfiguration } from './provider-status';

/** The process-wide pieces `system.health` needs (a slice of `Infrastructure`). */
export interface SystemHealthDeps {
  readonly config: AppConfig;
  readonly health: Pick<HealthRegistry, 'systemHealth'>;
  readonly repos: Pick<Repositories, 'migrationStatus'>;
  readonly logger: { warn(fields: object, message: string): void };
  readonly now: () => Date;
}

async function readMigrations(
  deps: Pick<SystemHealthDeps, 'repos' | 'logger'>,
): Promise<{ migrations: SystemHealth['migrations']; notices: string[] }> {
  try {
    const status = await deps.repos.migrationStatus();
    return {
      migrations: {
        applied: status.applied.length,
        pending: status.pending.length,
        latest: status.latest,
      },
      notices:
        status.checksumMismatch.length > 0
          ? [
              `${status.checksumMismatch.length} applied migration(s) changed after they ran; the schema may not match the code.`,
            ]
          : [],
    };
  } catch (error) {
    // The health endpoint must answer even when the database does not: the database check reports it.
    deps.logger.warn({ err: error }, 'migration status could not be read');
    return {
      migrations: { applied: 0, pending: 0, latest: null },
      notices: ['Migration status is unavailable because the database could not be queried.'],
    };
  }
}

/**
 * Dependency health, migration status and AI provider status. Probed dependencies come from the health
 * registry; the AI provider comes from the AI service's runtime health (`ai`, null when it could not
 * report); configured-but-unprobed integrations are `unknown`, and stand-ins stay labelled `simulated`.
 */
export async function buildSystemHealth(
  deps: SystemHealthDeps,
  ai: AiHealth | null,
): Promise<SystemHealth> {
  const { migrations, notices } = await readMigrations(deps);
  const provider =
    ai === null
      ? unavailableProvider(deps.config.ai, deps.now())
      : withConfiguration(ai.provider, deps.config.ai);
  const report = await deps.health.systemHealth({
    migrations,
    provider,
    notices: [
      ...notices,
      ...integrationNotices(deps.config),
      ...(ai === null
        ? ['The AI provider could not be initialised; see the server log.']
        : ai.notes),
    ],
  });
  return {
    ...report,
    dependencies: reconcileDependencies(report.dependencies, deps.config, report.checkedAt, ai),
  };
}
