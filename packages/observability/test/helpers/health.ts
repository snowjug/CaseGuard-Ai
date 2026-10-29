import type { ProviderStatus } from '@caseguard/schemas';
import { HealthRegistry, type HealthRegistryOptions } from '../../src';
import { createManualClock, createManualMonotonic } from './fakes';

export const provider: ProviderStatus = {
  kind: 'deterministic',
  configured: true,
  healthy: true,
  model: 'deterministic-knowledge-pack',
  simulated: true,
  checkedAt: '2026-10-29T09:14:14.599Z',
  detail: 'In-process deterministic provider.',
  validationNote: 'Synthetic values; not validated against a live service.',
  limits: { maxInputTokens: 24000, maxOutputTokens: 4000, timeoutMs: 30000, maxRetries: 2 },
};

export const migrations = { applied: 12, pending: 0, latest: '0012_audit_chain' };

/** A registry with injected clocks; it started 125 s before the manual clock's current time. */
export function buildHealth(options: Partial<HealthRegistryOptions> = {}) {
  const clock = createManualClock(Date.parse('2026-10-29T09:14:14.599Z'));
  const monotonic = createManualMonotonic();
  const registry = new HealthRegistry({
    service: 'caseguard-api',
    version: '1.2.3',
    commit: 'abc1234',
    environment: 'staging',
    clock: clock.now,
    monotonic: monotonic.now,
    startedAtMs: clock.now() - 125_000,
    ...options,
  });
  return { registry, clock, monotonic };
}

export const ok = (): Promise<void> => Promise.resolve();
