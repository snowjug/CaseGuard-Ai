import { noopLogger, noopMetrics, type Clock, type Logger, type Metrics } from '../types';
import { toIso } from '../util/ids';

export type BreakerState = 'closed' | 'open' | 'half_open';

/** Matches the `circuitBreakers` entries of the efficiency overview contract. */
export interface BreakerSnapshot {
  name: string;
  state: BreakerState;
  consecutiveFailures: number;
  openedAt: string | null;
}

export interface CircuitBreakerOptions {
  name: string;
  failureThreshold: number;
  /** Time spent open before a single probe call is allowed (half-open). */
  resetMs: number;
  clock: Clock;
  /** Concurrent trial calls allowed while half-open. */
  halfOpenMaxProbes?: number;
  logger?: Logger;
  metrics?: Metrics;
}

/**
 * Classic closed / open / half-open breaker. Time comes from the injected clock, so transitions
 * are deterministic in tests. Only failures that indicate provider ill-health should be recorded.
 */
export class CircuitBreaker {
  private current: BreakerState = 'closed';
  private failures = 0;
  private openedAtMs: number | null = null;
  private probesInFlight = 0;
  private readonly logger: Logger;
  private readonly metrics: Metrics;
  private readonly halfOpenMaxProbes: number;

  constructor(private readonly options: CircuitBreakerOptions) {
    this.logger = options.logger ?? noopLogger;
    this.metrics = options.metrics ?? noopMetrics;
    this.halfOpenMaxProbes = options.halfOpenMaxProbes ?? 1;
  }

  /** Current state; an open breaker becomes half-open once the reset time has elapsed. */
  state(): BreakerState {
    if (
      this.current === 'open' &&
      this.openedAtMs !== null &&
      this.options.clock.nowMs() - this.openedAtMs >= this.options.resetMs
    ) {
      this.transition('half_open');
      this.probesInFlight = 0;
    }
    return this.current;
  }

  /** True when a call may proceed. In half-open state it reserves one of the probe slots. */
  tryAcquire(): boolean {
    const state = this.state();
    if (state === 'closed') return true;
    if (state === 'open') return false;
    if (this.probesInFlight >= this.halfOpenMaxProbes) return false;
    this.probesInFlight++;
    return true;
  }

  recordSuccess(): void {
    if (this.current === 'half_open') this.probesInFlight = Math.max(0, this.probesInFlight - 1);
    this.failures = 0;
    if (this.current !== 'closed') {
      this.openedAtMs = null;
      this.transition('closed');
    }
  }

  recordFailure(): void {
    if (this.current === 'half_open') {
      this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      this.open();
      return;
    }
    this.failures++;
    if (this.current === 'closed' && this.failures >= this.options.failureThreshold) this.open();
  }

  /** Releases a reserved probe slot when a call ended without telling us about provider health. */
  recordNeutral(): void {
    if (this.current === 'half_open') this.probesInFlight = Math.max(0, this.probesInFlight - 1);
  }

  private open(): void {
    this.openedAtMs = this.options.clock.nowMs();
    this.transition('open');
  }

  private transition(next: BreakerState): void {
    if (next === this.current) return;
    const previous = this.current;
    this.current = next;
    this.metrics.gauge('ai.circuit.open', next === 'open' ? 1 : 0, { breaker: this.options.name });
    this.logger.warn(
      { event: 'ai.circuit.transition', breaker: this.options.name, from: previous, to: next },
      `Circuit breaker ${this.options.name} changed state`,
    );
  }

  snapshot(): BreakerSnapshot {
    return {
      name: this.options.name,
      state: this.state(),
      consecutiveFailures: this.failures,
      openedAt: this.openedAtMs === null ? null : toIso(this.openedAtMs),
    };
  }
}
