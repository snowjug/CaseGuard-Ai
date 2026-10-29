import type { FastifyInstance } from 'fastify';
import type { Infrastructure } from '../infrastructure';

/**
 * Unversioned, unauthenticated probes for the platform.
 *
 * - `/livez` and `/healthz` answer from the process alone and never touch a dependency, so a database
 *   outage cannot make the orchestrator restart a healthy container.
 * - `/readyz` runs the (cached) dependency checks and returns 503 only when a critical one is down.
 *   It reports names and states, never error text, so it reveals nothing about internals.
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  infra: Pick<Infrastructure, 'health'>,
): void {
  const exempt = { config: { rateLimit: false as const } };
  const liveness = () => infra.health.liveness();

  app.get('/livez', exempt, liveness);
  app.get('/healthz', exempt, liveness);
  app.get('/readyz', exempt, async (_request, reply) => {
    const report = await infra.health.readiness({ detail: 'minimal' });
    void reply.code(report.httpStatus);
    return report;
  });
}
