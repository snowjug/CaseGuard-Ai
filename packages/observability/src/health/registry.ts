import type { SystemHealth } from '@caseguard/schemas';
import { elapsedMs, systemClock, systemMonotonicClock, toIsoTimestamp } from '../clock';
import { createScrubber, type Scrubber } from '../redaction/scrubber';
import { overallHealthStatus, toDependencyHealth } from './dto';
import { sanitizeErrorDetail } from './sanitize';
import type {
  DependencyKind,
  HealthCheckDefinition,
  HealthCheckResult,
  HealthRegistryOptions,
  HealthState,
  LivenessReport,
  ReadinessCheckReport,
  ReadinessOptions,
  ReadinessReport,
  SystemHealthInput,
} from './types';

const CHECK_NAME = /^[a-z][a-z0-9_.-]{0,62}$/;
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_CACHE_TTL_MS = 5000;
const MAX_DETAIL_LENGTH = 400;
const VALID_STATES: ReadonlySet<string> = new Set<HealthState>(['up', 'degraded', 'down']);

/** Names and criticality of the dependencies the platform checks. Readiness depends on the first two only. */
export const STANDARD_HEALTH_CHECKS = {
  database: { name: 'database', kind: 'database', critical: true },
  migrations: { name: 'migrations', kind: 'migrations', critical: true },
  storage: { name: 'storage', kind: 'storage', critical: false },
  search: { name: 'search', kind: 'search', critical: false },
  modelProvider: { name: 'model_provider', kind: 'ai_provider', critical: false },
  cache: { name: 'cache', kind: 'cache', critical: false },
} as const satisfies Record<string, { name: string; kind: DependencyKind; critical: boolean }>;

/** Key of a standard dependency in `STANDARD_HEALTH_CHECKS`. */
export type StandardHealthCheck = keyof typeof STANDARD_HEALTH_CHECKS;

class HealthCheckTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Check timed out after ${timeoutMs} ms`);
    this.name = 'HealthCheckTimeoutError';
  }
}

interface CachedResult {
  readonly result: HealthCheckResult;
  readonly expiresAtMs: number;
}

/** Folds executed results into one state: a critical `down` is `down`; any other problem is `degraded`. */
function overallState(results: readonly HealthCheckResult[]): HealthState {
  let degraded = false;
  for (const result of results) {
    if (result.status === 'disabled') continue;
    if (result.status === 'down') {
      if (result.critical) return 'down';
      degraded = true;
    } else if (result.status === 'degraded') {
      degraded = true;
    }
  }
  return degraded ? 'degraded' : 'up';
}

/**
 * Registry of named dependency checks with timeouts, result caching and single-flight execution.
 *
 * - Liveness never calls a dependency.
 * - Readiness runs the checks (cached) and fails only when a critical check is down.
 * - Reported errors are one-line, scrubbed and stack-free; unauthenticated callers should use
 *   `detail: 'minimal'`, which omits them altogether.
 */
export class HealthRegistry {
  private readonly checks = new Map<string, HealthCheckDefinition>();
  private readonly cache = new Map<string, CachedResult>();
  private readonly inFlight = new Map<string, Promise<HealthCheckResult>>();
  private readonly clock: () => number;
  private readonly monotonic: () => number;
  private readonly startedAtMs: number;
  private readonly scrubber: Scrubber;

  constructor(private readonly options: HealthRegistryOptions) {
    this.clock = options.clock ?? systemClock;
    this.monotonic = options.monotonic ?? systemMonotonicClock;
    this.startedAtMs = options.startedAtMs ?? this.clock();
    this.scrubber = createScrubber({
      includeStack: false,
      ...(options.redact ? { redact: options.redact } : {}),
    });
  }

  /** Registers a check. Throws on an invalid or duplicate name: that is a wiring bug. */
  register(definition: HealthCheckDefinition): void {
    if (!CHECK_NAME.test(definition.name)) {
      throw new TypeError(`Invalid health check name "${definition.name}"`);
    }
    if (this.checks.has(definition.name)) {
      throw new Error(`Health check "${definition.name}" is already registered`);
    }
    this.checks.set(definition.name, definition);
  }

  /** Registers one of the standard dependencies with its conventional name, kind and criticality. */
  registerStandard(
    key: StandardHealthCheck,
    check: HealthCheckDefinition['check'],
    overrides: Partial<Omit<HealthCheckDefinition, 'check'>> = {},
  ): void {
    this.register({ ...STANDARD_HEALTH_CHECKS[key], check, ...overrides });
  }

  unregister(name: string): boolean {
    this.cache.delete(name);
    return this.checks.delete(name);
  }

  names(): string[] {
    return [...this.checks.keys()];
  }

  /** Process-only answer: never calls a dependency, so it cannot fail because one is down. */
  liveness(): LivenessReport {
    const now = this.clock();
    return {
      status: 'up',
      service: this.options.service,
      version: this.options.version,
      uptimeSeconds: this.uptimeSeconds(now),
      checkedAt: toIsoTimestamp(now),
    };
  }

  /** Runs (or reuses cached) checks. Ready unless a critical check is down. */
  async readiness(options: ReadinessOptions = {}): Promise<ReadinessReport> {
    const results = await this.checkAll({ refresh: options.refresh === true });
    const status = overallState(results);
    const ready = status !== 'down';
    const full = options.detail === 'full';
    return {
      status,
      ready,
      httpStatus: ready ? 200 : 503,
      service: this.options.service,
      version: this.options.version,
      checkedAt: toIsoTimestamp(this.clock()),
      checks: results.map((result): ReadinessCheckReport => ({
        name: result.name,
        kind: result.kind,
        critical: result.critical,
        status: result.status,
        latencyMs: result.latencyMs,
        checkedAt: result.checkedAt,
        ...(full ? { detail: result.detail } : {}),
      })),
    };
  }

  /** Runs every check concurrently, in registration order. */
  async checkAll(options: { readonly refresh?: boolean } = {}): Promise<HealthCheckResult[]> {
    const definitions = [...this.checks.values()];
    return Promise.all(
      definitions.map((definition) => this.evaluate(definition, options.refresh === true)),
    );
  }

  /** Runs one check by name. Throws if it is not registered. */
  async check(
    name: string,
    options: { readonly refresh?: boolean } = {},
  ): Promise<HealthCheckResult> {
    const definition = this.checks.get(name);
    if (definition === undefined) throw new Error(`Unknown health check "${name}"`);
    return this.evaluate(definition, options.refresh === true);
  }

  /** The system-health DTO served to operators (`GET /api/v1/system/health`). */
  async systemHealth(input: SystemHealthInput): Promise<SystemHealth> {
    const results = await this.checkAll({ refresh: input.refresh === true });
    const now = this.clock();
    const enabled = results.filter((result) => result.status !== 'disabled');
    const standIns = enabled
      .filter((result) => result.simulated)
      .map(
        (result) =>
          `Dependency "${result.name}" is an in-process or synthetic stand-in, not a live service.`,
      );
    return {
      status: overallHealthStatus(overallState(results), enabled.length > 0),
      service: this.options.service,
      version: this.options.version,
      commit: this.options.commit ?? null,
      environment: this.options.environment,
      uptimeSeconds: this.uptimeSeconds(now),
      checkedAt: toIsoTimestamp(now),
      dependencies: results.map(toDependencyHealth),
      migrations: input.migrations,
      provider: input.provider,
      notices: [...new Set([...(input.notices ?? []), ...standIns])],
    };
  }

  private uptimeSeconds(now: number): number {
    return Math.max(0, Math.floor((now - this.startedAtMs) / 1000));
  }

  private isEnabled(definition: HealthCheckDefinition): boolean {
    const { enabled } = definition;
    return typeof enabled === 'function' ? enabled() : enabled !== false;
  }

  private evaluate(
    definition: HealthCheckDefinition,
    refresh: boolean,
  ): Promise<HealthCheckResult> {
    const now = this.clock();
    if (!this.isEnabled(definition)) {
      return Promise.resolve(this.disabledResult(definition, now));
    }
    if (!refresh) {
      const cached = this.cache.get(definition.name);
      if (cached !== undefined && cached.expiresAtMs > now) {
        return Promise.resolve({ ...cached.result, cached: true });
      }
    }
    const running = this.inFlight.get(definition.name);
    if (running !== undefined) return running;
    const run = this.execute(definition)
      .then((result) => {
        const ttl = definition.cacheTtlMs ?? this.options.defaultCacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        if (ttl > 0) this.cache.set(definition.name, { result, expiresAtMs: this.clock() + ttl });
        return result;
      })
      .finally(() => {
        this.inFlight.delete(definition.name);
      });
    this.inFlight.set(definition.name, run);
    return run;
  }

  private disabledResult(definition: HealthCheckDefinition, now: number): HealthCheckResult {
    return {
      name: definition.name,
      kind: definition.kind,
      critical: definition.critical,
      simulated: definition.simulated === true,
      status: 'disabled',
      latencyMs: null,
      checkedAt: toIsoTimestamp(now),
      detail: 'Not enabled in this environment.',
      timedOut: false,
      cached: false,
    };
  }

  /** Never rejects: every outcome, including a throw or timeout, becomes a result. */
  private async execute(definition: HealthCheckDefinition): Promise<HealthCheckResult> {
    const timeoutMs = definition.timeoutMs ?? this.options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const startedAt = this.monotonic();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: HealthState = 'up';
    let detail = '';
    let timedOut = false;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          const error = new HealthCheckTimeoutError(timeoutMs);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      const outcome = await Promise.race([
        Promise.resolve().then(() => definition.check({ signal: controller.signal })),
        timeout,
      ]);
      const reported = outcome?.status ?? 'up';
      if (!VALID_STATES.has(reported)) {
        // A check that reports a state outside the contract is itself broken: fail closed.
        status = 'down';
        detail = 'Check reported an invalid status.';
      } else {
        status = reported;
        detail =
          outcome?.detail === undefined
            ? ''
            : this.scrubber.text(outcome.detail, MAX_DETAIL_LENGTH);
      }
    } catch (error) {
      status = 'down';
      detail = timedOut
        ? `Timed out after ${timeoutMs} ms`
        : sanitizeErrorDetail(error, this.scrubber);
      this.options.onCheckError?.(definition.name, error);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    return {
      name: definition.name,
      kind: definition.kind,
      critical: definition.critical,
      simulated: definition.simulated === true,
      status,
      latencyMs: Math.round(elapsedMs(startedAt, this.monotonic()) * 1000) / 1000,
      checkedAt: toIsoTimestamp(this.clock()),
      detail,
      timedOut,
      cached: false,
    };
  }
}
