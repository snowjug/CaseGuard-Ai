import type { DependencyHealth, HealthStatus } from '@caseguard/schemas';
import type { HealthCheckResult, HealthCheckStatus, HealthState } from './types';

const MAX_DTO_DETAIL_LENGTH = 400;

/** Maps registry states onto the contract's vocabulary: up→healthy, down→unhealthy. */
export function toHealthStatus(status: HealthCheckStatus): HealthStatus {
  switch (status) {
    case 'up':
      return 'healthy';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'unhealthy';
    case 'disabled':
      return 'disabled';
  }
}

/** Overall status for the system-health DTO; `unknown` when nothing is enabled to be checked. */
export function overallHealthStatus(state: HealthState, anyEnabled: boolean): HealthStatus {
  return anyEnabled ? toHealthStatus(state) : 'unknown';
}

/** Converts one check result into the `DependencyHealth` shape of `@caseguard/schemas`. */
export function toDependencyHealth(result: HealthCheckResult): DependencyHealth {
  return {
    name: result.name,
    kind: result.kind,
    status: toHealthStatus(result.status),
    latencyMs: result.latencyMs,
    detail: result.detail.slice(0, MAX_DTO_DETAIL_LENGTH),
    checkedAt: result.checkedAt,
    simulated: result.simulated,
  };
}
