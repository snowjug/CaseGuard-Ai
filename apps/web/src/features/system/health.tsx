'use client';

import type { HealthStatus } from '@caseguard/schemas';
import { StateBadge } from '../../lib/advanced-view-parts';
import { HEALTH_BADGES } from '../../lib/labels';

/** What each health status means, as the tooltip of its badge. */
export const HEALTH_TITLES: Record<HealthStatus, string> = {
  healthy: 'The check passed.',
  degraded: 'It works, with problems.',
  unhealthy: 'The check failed.',
  unknown: 'Configured, but not checked from here, so it is never reported as healthy.',
  disabled: 'Switched off.',
};

/** The word, colour and icon of a health status, with its meaning on hover. */
export function HealthBadge({ status }: { status: HealthStatus }) {
  const badge = HEALTH_BADGES[status];
  return <StateBadge status={badge.status} label={badge.label} title={HEALTH_TITLES[status]} />;
}
