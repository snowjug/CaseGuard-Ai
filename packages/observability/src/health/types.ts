import type {
  AppEnvironment,
  DependencyHealth,
  ProviderStatus,
  SystemHealth,
} from '@caseguard/schemas';

/** Result of an executed check: `up` (healthy), `degraded` (working with reduced capability), `down`. */
export type HealthState = 'up' | 'degraded' | 'down';

/** A check that did not run because its feature is switched off reports `disabled`. */
export type HealthCheckStatus = HealthState | 'disabled';

/** Dependency categories of the system-health DTO (database, migrations, ai_provider, search, ...). */
export type DependencyKind = DependencyHealth['kind'];

/** Argument handed to a health check function. */
export interface HealthCheckContext {
  /** Aborted when the check times out; well-behaved checks pass it to fetch or the driver. */
  readonly signal: AbortSignal;
}

/** What a check returns. Returning nothing means "up"; throwing means "down". */
export interface HealthCheckOutcome {
  readonly status?: HealthState;
  /** Short human-readable note (sanitised before it is reported). */
  readonly detail?: string;
}

/** A dependency probe: resolves when healthy, may return a state, throws when down. */
export type HealthCheckFn = (
  context: HealthCheckContext,
) => Promise<HealthCheckOutcome | void> | HealthCheckOutcome | void;

/** A named dependency check as registered on a `HealthRegistry`. */
export interface HealthCheckDefinition {
  /** Unique, lower-case, URL-safe name (for example `database`). */
  readonly name: string;
  readonly kind: DependencyKind;
  /** Critical checks decide readiness; non-critical ones only degrade the overall status. */
  readonly critical: boolean;
  readonly check: HealthCheckFn;
  /** Per-check timeout; defaults to the registry default (2000 ms). */
  readonly timeoutMs?: number;
  /** How long a result is reused; 0 disables caching. Defaults to the registry default (5000 ms). */
  readonly cacheTtlMs?: number;
  /** True for in-process or synthetic stand-ins (deterministic AI provider, local object store, lexical search). */
  readonly simulated?: boolean;
  /** When false (or the function returns false) the check is not called and reports `disabled`. */
  readonly enabled?: boolean | (() => boolean);
}

/** Outcome of one check execution (or of serving it from the cache). */
export interface HealthCheckResult {
  readonly name: string;
  readonly kind: DependencyKind;
  readonly critical: boolean;
  readonly simulated: boolean;
  readonly status: HealthCheckStatus;
  /** Wall time of the check; null when it did not run. */
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  /** Sanitised note or error message: no secrets, no stack, at most 400 characters. */
  readonly detail: string;
  readonly timedOut: boolean;
  /** True when this result was served from the cache instead of running the check. */
  readonly cached: boolean;
}

/** Body of `GET /livez`. */
export interface LivenessReport {
  /** Liveness only says "the process can answer"; it never touches a dependency. */
  readonly status: 'up';
  readonly service: string;
  readonly version: string;
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
}

/** One check as shown in a readiness report. */
export interface ReadinessCheckReport {
  readonly name: string;
  readonly kind: DependencyKind;
  readonly critical: boolean;
  readonly status: HealthCheckStatus;
  readonly latencyMs: number | null;
  readonly checkedAt: string;
  /** Present only with `detail: 'full'`. */
  readonly detail?: string;
}

/** Body of `GET /readyz`; serve it with `httpStatus`. */
export interface ReadinessReport {
  readonly status: HealthState;
  /** False only when a critical check is down. */
  readonly ready: boolean;
  /** 200 when ready, 503 otherwise. */
  readonly httpStatus: 200 | 503;
  readonly service: string;
  readonly version: string;
  readonly checkedAt: string;
  readonly checks: readonly ReadinessCheckReport[];
}

/** Options for `HealthRegistry.readiness`. */
export interface ReadinessOptions {
  /** Bypass the cache and re-run every check. */
  readonly refresh?: boolean;
  /** `minimal` (default) omits error details so unauthenticated probes reveal nothing about internals. */
  readonly detail?: 'minimal' | 'full';
}

/** Inputs the registry cannot know: migration counts and the AI provider's own status. */
export interface SystemHealthInput {
  readonly migrations: SystemHealth['migrations'];
  readonly provider: ProviderStatus;
  /** Extra honesty notices; stand-in dependencies add their own automatically. */
  readonly notices?: readonly string[];
  readonly refresh?: boolean;
}

/** Options for the `HealthRegistry` constructor. */
export interface HealthRegistryOptions {
  readonly service: string;
  readonly version: string;
  readonly commit?: string | null;
  readonly environment: AppEnvironment;
  readonly clock?: () => number;
  /** Monotonic clock for latency; inject a fake in tests. */
  readonly monotonic?: () => number;
  /** Process start in epoch ms for uptime; defaults to the construction time. */
  readonly startedAtMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly defaultCacheTtlMs?: number;
  /** Extra text redactor applied to error messages (the built-in scrubber always runs first). */
  readonly redact?: (text: string) => string;
  /**
   * Called with the raw error when a check throws or times out, so the caller can log it with its own
   * (redacting) logger. It must not throw.
   */
  readonly onCheckError?: (name: string, error: unknown) => void;
}
