import {
  createMetricsRegistry,
  createProductMetrics,
  type MetricsRegistry,
  type ProductMetrics,
} from '../../src';
import { createManualClock, createManualMonotonic } from './fakes';
import { parsePrometheus, type ParsedFamily } from './prometheus';

/** A registry with the product metrics registered, injected clocks and a parsed-exposition lookup. */
export function setupProduct(): {
  registry: MetricsRegistry;
  product: ProductMetrics;
  clock: ReturnType<typeof createManualClock>;
  monotonic: ReturnType<typeof createManualMonotonic>;
  families: () => ParsedFamily[];
  sample: (name: string, labels?: Record<string, string>) => number | undefined;
} {
  const clock = createManualClock(Date.parse('2026-10-29T09:14:14.599Z'));
  const monotonic = createManualMonotonic();
  const registry = createMetricsRegistry({ clock: clock.now, monotonic: monotonic.now });
  const product = createProductMetrics(registry, {
    service: 'caseguard-api',
    version: '1.2.3',
    commit: 'abc1234',
    clock: clock.now,
  });
  const families = (): ParsedFamily[] => parsePrometheus(registry.renderPrometheus());
  const sample = (name: string, labels: Record<string, string> = {}): number | undefined => {
    const family = families().find((f) => name === f.name || name.startsWith(`${f.name}_`));
    return family?.samples.find(
      (s) =>
        s.name === name && Object.entries(labels).every(([key, value]) => s.labels[key] === value),
    )?.value;
  };
  return { registry, product, clock, monotonic, families, sample };
}
