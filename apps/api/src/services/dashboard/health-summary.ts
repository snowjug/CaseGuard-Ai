import type { SystemHealth, SystemHealthSummary } from '@caseguard/schemas';

/**
 * The command center's one-line view of the system status, reduced from the system service's full
 * report (which is reused as it is, not recomputed): the overall status, how many dependencies are
 * healthy, degraded or unhealthy, and what the AI provider honestly is.
 */
export function summarizeHealth(report: SystemHealth): SystemHealthSummary {
  const count = (status: SystemHealth['dependencies'][number]['status']): number =>
    report.dependencies.filter((dependency) => dependency.status === status).length;
  return {
    status: report.status,
    healthy: count('healthy'),
    degraded: count('degraded'),
    unhealthy: count('unhealthy'),
    providerKind: report.provider.kind,
    providerSimulated: report.provider.simulated,
  };
}
