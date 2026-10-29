import type { ExecutionStatus } from '@caseguard/schemas';
import { elapsedMs, systemClock, type Clock } from '../clock';
import type { MetricsRegistry } from './registry';
import type { Counter, Gauge, Histogram } from './types';

/** Stable metric names; dashboards, alerts and the documented KQL/PromQL queries refer to these. */
export const METRIC_NAMES = {
  httpRequests: 'caseguard_http_requests_total',
  httpDuration: 'caseguard_http_request_duration_seconds',
  errors: 'caseguard_errors_total',
  jobsActive: 'caseguard_jobs_active',
  jobDuration: 'caseguard_job_duration_seconds',
  jobFailures: 'caseguard_job_failures_total',
  queueDepth: 'caseguard_queue_depth',
  modelCalls: 'caseguard_model_calls_total',
  modelTokens: 'caseguard_model_tokens_total',
  modelDuration: 'caseguard_model_call_duration_seconds',
  modelCacheLookups: 'caseguard_model_cache_lookups_total',
  modelCacheHitRatio: 'caseguard_model_cache_hit_ratio',
  modelFallbacks: 'caseguard_model_fallbacks_total',
  modelValidationFailures: 'caseguard_model_validation_failures_total',
  analysisDuration: 'caseguard_analysis_duration_seconds',
  leakCheckFailures: 'caseguard_counterfactual_leak_check_failures_total',
  authFailures: 'caseguard_auth_failures_total',
  forbidden: 'caseguard_forbidden_total',
  rateLimitHits: 'caseguard_rate_limit_hits_total',
  injectionFlags: 'caseguard_prompt_injection_flags_total',
  dbQueryDuration: 'caseguard_db_query_duration_seconds',
  retrievalDuration: 'caseguard_retrieval_duration_seconds',
  skillTransitions: 'caseguard_skill_transitions_total',
  buildInfo: 'caseguard_build_info',
  processStartTime: 'caseguard_process_start_time_seconds',
} as const;

/** Bucket upper bounds (seconds) for HTTP request latency. */
export const HTTP_LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];
/** Bucket upper bounds (seconds) for database query latency. */
export const DB_LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];
/** Bucket upper bounds (seconds) for evidence-retrieval latency. */
export const RETRIEVAL_LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5,
];
/** Bucket upper bounds (seconds) for model-call latency. */
export const MODEL_LATENCY_BUCKETS_SECONDS: readonly number[] = [
  0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120,
];
/** Bucket upper bounds (seconds) for job and analysis duration. */
export const JOB_DURATION_BUCKETS_SECONDS: readonly number[] = [
  0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600,
];

/** How a model call's token counts were obtained. */
export type TokenSource = 'measured' | 'estimated';
/** Validation stage that rejected a model output. */
export type ValidationFailureKind = 'schema' | 'citation' | 'policy' | 'temporal';
/** Terminal job state recorded in metrics. */
export type JobOutcome = 'succeeded' | 'failed' | 'cancelled';
/** HTTP status class label. */
export type StatusClass = '1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other';

/** Execution statuses that count as a failed model call (cache hits and cancellations do not). */
export const MODEL_FAILURE_STATUSES: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>([
  'failed',
  'timed_out',
  'rejected_by_validation',
  'circuit_open',
  'budget_exceeded',
]);

/** One finished HTTP request, as passed to `recordHttpRequest`. */
export interface HttpRequestRecord {
  readonly method: string;
  /** Route pattern such as `/api/v1/cases/:caseId`, never the raw URL (cardinality and privacy). */
  readonly route: string | undefined;
  readonly statusCode: number;
  readonly durationMs: number;
}

/** One model call, as passed to `recordModelCall`. */
export interface ModelCallRecord {
  readonly agent: string;
  readonly provider: string;
  readonly status: ExecutionStatus;
  readonly latencyMs: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly cachedTokens?: number;
  /** `measured` when the provider reported usage; `estimated` for counts the platform computed itself. */
  readonly tokenSource: TokenSource;
  /** Whether a cache lookup was made and hit; omit when no lookup happened. */
  readonly cacheHit?: boolean;
  /** Why the call fell back to another provider or the deterministic path, if it did. */
  readonly fallbackReason?: string;
  readonly validationFailures?: readonly ValidationFailureKind[];
}

/** Handle for a running job returned by `startJob`. */
export interface JobTracker {
  /** Ends the job once: decrements the active gauge, records duration and, for `failed`, the reason. */
  finish(outcome: JobOutcome, failureReason?: string): void;
}

type HttpLabels = 'method' | 'route' | 'status_class';

/** The platform's product metrics: typed instrument handles plus `record*` helpers. */
export interface ProductMetrics {
  readonly registry: MetricsRegistry;
  readonly httpRequests: Counter<HttpLabels>;
  readonly httpDuration: Histogram<HttpLabels>;
  readonly errors: Counter<'component' | 'code'>;
  readonly jobsActive: Gauge<'kind'>;
  readonly jobDuration: Histogram<'kind' | 'status'>;
  readonly jobFailures: Counter<'kind' | 'reason'>;
  readonly queueDepth: Gauge<'queue'>;
  readonly modelCalls: Counter<'agent' | 'provider' | 'status'>;
  readonly modelTokens: Counter<'agent' | 'provider' | 'direction' | 'source'>;
  readonly modelDuration: Histogram<'agent' | 'provider'>;
  readonly modelCacheLookups: Counter<'result'>;
  readonly modelFallbacks: Counter<'agent' | 'reason'>;
  readonly modelValidationFailures: Counter<'agent' | 'kind'>;
  readonly analysisDuration: Histogram<'outcome'>;
  /** Must stay 0: a non-zero value means a counterfactual used information from after its decision time. */
  readonly leakCheckFailures: Counter;
  readonly authFailures: Counter<'reason'>;
  readonly forbidden: Counter<'permission'>;
  readonly rateLimitHits: Counter<'limiter'>;
  readonly injectionFlags: Counter<'source'>;
  readonly dbQueryDuration: Histogram<'operation'>;
  readonly retrievalDuration: Histogram<'provider' | 'outcome'>;
  readonly skillTransitions: Counter<'transition' | 'outcome'>;

  /** Records one finished HTTP request (count and duration by method, route pattern, status class). */
  recordHttpRequest(record: HttpRequestRecord): void;
  /** Counts a handled error by component and bounded error code. */
  recordError(component: string, code: string): void;
  /** Marks a job as started; call `finish` on the returned tracker when it ends. */
  startJob(kind: string): JobTracker;
  setQueueDepth(queue: string, depth: number): void;
  /** Records one model call: count, latency, tokens (measured vs estimated), cache, fallback, validation. */
  recordModelCall(record: ModelCallRecord): void;
  recordAnalysis(durationMs: number, outcome: JobOutcome): void;
  /** Records counterfactual leak-check failures. The expected value is, and must stay, zero. */
  recordLeakCheckFailure(count?: number): void;
  recordAuthFailure(reason: string): void;
  recordForbidden(permission: string): void;
  recordRateLimitHit(limiter: string): void;
  recordInjectionFlag(source: string): void;
  recordDbQuery(operation: string, durationMs: number): void;
  recordRetrieval(provider: string, outcome: 'ok' | 'error' | 'fallback', durationMs: number): void;
  recordSkillTransition(transition: string, outcome: 'success' | 'denied' | 'failure'): void;
}

/** Options for `createProductMetrics`. */
export interface ProductMetricsOptions {
  readonly service: string;
  readonly version: string;
  readonly commit?: string;
  readonly clock?: Clock;
}

const HTTP_METHODS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/** HTTP status class label (`2xx`); anything outside 100-599 is `other`. */
export function statusClass(statusCode: number): StatusClass {
  if (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599) return 'other';
  return `${Math.floor(statusCode / 100)}xx` as StatusClass;
}

/** Keeps a number only when it is finite and non-negative; recording helpers drop anything else. */
function usable(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Milliseconds to seconds, or `undefined` when the input is not a usable duration. */
function toSeconds(milliseconds: number | undefined): number | undefined {
  const value = usable(milliseconds);
  return value === undefined ? undefined : value / 1000;
}

/**
 * Registers the platform's product metrics on `registry` and returns typed handles plus `record*`
 * helpers. The helpers are deliberately non-throwing for bad numbers (a negative latency or NaN
 * token count is skipped, not raised) because they run inside request and model-call paths.
 */
export function createProductMetrics(
  registry: MetricsRegistry,
  options: ProductMetricsOptions,
): ProductMetrics {
  const clock = options.clock ?? systemClock;

  const httpRequests = registry.counter({
    name: METRIC_NAMES.httpRequests,
    help: 'HTTP requests served, by method, route pattern and status class.',
    labelNames: ['method', 'route', 'status_class'],
    unit: '1',
    labelValueLimits: { route: 200 },
  });
  const httpDuration = registry.histogram({
    name: METRIC_NAMES.httpDuration,
    help: 'HTTP request duration in seconds, by method, route pattern and status class.',
    labelNames: ['method', 'route', 'status_class'],
    unit: 's',
    buckets: HTTP_LATENCY_BUCKETS_SECONDS,
    labelValueLimits: { route: 200 },
  });
  const errors = registry.counter({
    name: METRIC_NAMES.errors,
    help: 'Handled errors by component and error code.',
    labelNames: ['component', 'code'],
    unit: '1',
    labelValueLimits: { code: 100 },
  });
  const jobsActive = registry.gauge({
    name: METRIC_NAMES.jobsActive,
    help: 'Jobs currently running, by kind.',
    labelNames: ['kind'],
    unit: '1',
  });
  const jobDuration = registry.histogram({
    name: METRIC_NAMES.jobDuration,
    help: 'Job duration in seconds, by kind and terminal status.',
    labelNames: ['kind', 'status'],
    unit: 's',
    buckets: JOB_DURATION_BUCKETS_SECONDS,
  });
  const jobFailures = registry.counter({
    name: METRIC_NAMES.jobFailures,
    help: 'Failed jobs by kind and failure reason.',
    labelNames: ['kind', 'reason'],
    unit: '1',
  });
  const queueDepth = registry.gauge({
    name: METRIC_NAMES.queueDepth,
    help: 'Jobs waiting in a queue.',
    labelNames: ['queue'],
    unit: '1',
  });
  const modelCalls = registry.counter({
    name: METRIC_NAMES.modelCalls,
    help: 'Model calls by agent, provider and execution status.',
    labelNames: ['agent', 'provider', 'status'],
    unit: '1',
  });
  const modelTokens = registry.counter({
    name: METRIC_NAMES.modelTokens,
    help: 'Model tokens by direction (input, output, cached) and source (measured by the provider, or estimated).',
    labelNames: ['agent', 'provider', 'direction', 'source'],
    unit: '{token}',
  });
  const modelDuration = registry.histogram({
    name: METRIC_NAMES.modelDuration,
    help: 'Model call latency in seconds, by agent and provider.',
    labelNames: ['agent', 'provider'],
    unit: 's',
    buckets: MODEL_LATENCY_BUCKETS_SECONDS,
  });
  const modelCacheLookups = registry.counter({
    name: METRIC_NAMES.modelCacheLookups,
    help: 'Semantic cache lookups by result (hit or miss).',
    labelNames: ['result'],
    unit: '1',
  });
  registry.observableGauge({
    name: METRIC_NAMES.modelCacheHitRatio,
    help: 'Share of semantic cache lookups that hit (absent until the first lookup).',
    unit: '1',
    collect: () => {
      const lookups = modelCacheLookups.total();
      return lookups === 0 ? [] : [{ value: modelCacheLookups.get({ result: 'hit' }) / lookups }];
    },
  });
  const modelFallbacks = registry.counter({
    name: METRIC_NAMES.modelFallbacks,
    help: 'Model calls that fell back to another provider or the deterministic path.',
    labelNames: ['agent', 'reason'],
    unit: '1',
  });
  const modelValidationFailures = registry.counter({
    name: METRIC_NAMES.modelValidationFailures,
    help: 'Model outputs rejected by validation, by agent and check (schema, citation, policy, temporal).',
    labelNames: ['agent', 'kind'],
    unit: '1',
  });
  const analysisDuration = registry.histogram({
    name: METRIC_NAMES.analysisDuration,
    help: 'Case analysis duration in seconds, by outcome.',
    labelNames: ['outcome'],
    unit: 's',
    buckets: JOB_DURATION_BUCKETS_SECONDS,
  });
  const leakCheckFailures = registry.counter({
    name: METRIC_NAMES.leakCheckFailures,
    help: 'Counterfactual temporal leak-check failures. Must stay 0.',
    unit: '1',
  });
  const authFailures = registry.counter({
    name: METRIC_NAMES.authFailures,
    help: 'Authentication failures by reason.',
    labelNames: ['reason'],
    unit: '1',
  });
  const forbidden = registry.counter({
    name: METRIC_NAMES.forbidden,
    help: 'Authorisation denials by required permission.',
    labelNames: ['permission'],
    unit: '1',
    labelValueLimits: { permission: 100 },
  });
  const rateLimitHits = registry.counter({
    name: METRIC_NAMES.rateLimitHits,
    help: 'Requests rejected by a rate limiter.',
    labelNames: ['limiter'],
    unit: '1',
  });
  const injectionFlags = registry.counter({
    name: METRIC_NAMES.injectionFlags,
    help: 'Prompt-injection indicators detected in untrusted content, by source.',
    labelNames: ['source'],
    unit: '1',
  });
  const dbQueryDuration = registry.histogram({
    name: METRIC_NAMES.dbQueryDuration,
    help: 'Database query duration in seconds, by operation.',
    labelNames: ['operation'],
    unit: 's',
    buckets: DB_LATENCY_BUCKETS_SECONDS,
    labelValueLimits: { operation: 100 },
  });
  const retrievalDuration = registry.histogram({
    name: METRIC_NAMES.retrievalDuration,
    help: 'Evidence retrieval latency in seconds, by search provider and outcome.',
    labelNames: ['provider', 'outcome'],
    unit: 's',
    buckets: RETRIEVAL_LATENCY_BUCKETS_SECONDS,
  });
  const skillTransitions = registry.counter({
    name: METRIC_NAMES.skillTransitions,
    help: 'SkillDNA lifecycle transitions (approve, publish, retire, ...) by outcome.',
    labelNames: ['transition', 'outcome'],
    unit: '1',
  });

  registry
    .gauge({
      name: METRIC_NAMES.buildInfo,
      help: 'Build identity of the running service; the value is always 1.',
      labelNames: ['service', 'version', 'commit'],
    })
    .set(1, {
      service: options.service,
      version: options.version,
      commit: options.commit ?? 'unknown',
    });
  registry
    .gauge({
      name: METRIC_NAMES.processStartTime,
      help: 'Process start time in seconds since the Unix epoch.',
      unit: 's',
    })
    .set(clock() / 1000);

  return {
    registry,
    httpRequests,
    httpDuration,
    errors,
    jobsActive,
    jobDuration,
    jobFailures,
    queueDepth,
    modelCalls,
    modelTokens,
    modelDuration,
    modelCacheLookups,
    modelFallbacks,
    modelValidationFailures,
    analysisDuration,
    leakCheckFailures,
    authFailures,
    forbidden,
    rateLimitHits,
    injectionFlags,
    dbQueryDuration,
    retrievalDuration,
    skillTransitions,

    recordHttpRequest(record) {
      const method = record.method.toUpperCase();
      const labels = {
        method: HTTP_METHODS.has(method) ? method : 'OTHER',
        route: record.route === undefined || record.route === '' ? 'unmatched' : record.route,
        status_class: statusClass(record.statusCode),
      };
      httpRequests.inc(labels);
      const seconds = toSeconds(record.durationMs);
      if (seconds !== undefined) httpDuration.observe(seconds, labels);
    },

    recordError(component, code) {
      errors.inc({ component, code });
    },

    startJob(kind) {
      const start = registry.monotonic();
      let finished = false;
      jobsActive.inc({ kind });
      return {
        finish(outcome, failureReason) {
          if (finished) return;
          finished = true;
          jobsActive.dec({ kind });
          jobDuration.observe(elapsedMs(start, registry.monotonic()) / 1000, {
            kind,
            status: outcome,
          });
          if (outcome === 'failed')
            jobFailures.inc({ kind, reason: failureReason ?? 'unspecified' });
        },
      };
    },

    setQueueDepth(queue, depth) {
      const value = usable(depth);
      if (value !== undefined) queueDepth.set(value, { queue });
    },

    recordModelCall(record) {
      const { agent, provider } = record;
      modelCalls.inc({ agent, provider, status: record.status });
      const seconds = toSeconds(record.latencyMs);
      if (seconds !== undefined) modelDuration.observe(seconds, { agent, provider });
      const usage: readonly (readonly [string, number | undefined])[] = [
        ['input', record.promptTokens],
        ['output', record.completionTokens],
        ['cached', record.cachedTokens],
      ];
      for (const [direction, tokens] of usage) {
        const count = usable(tokens);
        if (count !== undefined && count > 0) {
          modelTokens.inc(
            { agent, provider, direction, source: record.tokenSource },
            Math.round(count),
          );
        }
      }
      const hit = record.status === 'cache_hit' || record.cacheHit === true;
      if (record.cacheHit !== undefined || record.status === 'cache_hit') {
        modelCacheLookups.inc({ result: hit ? 'hit' : 'miss' });
      }
      if (record.fallbackReason !== undefined) {
        modelFallbacks.inc({ agent, reason: record.fallbackReason });
      }
      for (const kind of record.validationFailures ?? []) {
        modelValidationFailures.inc({ agent, kind });
      }
    },

    recordAnalysis(durationMs, outcome) {
      const seconds = toSeconds(durationMs);
      if (seconds !== undefined) analysisDuration.observe(seconds, { outcome });
    },

    recordLeakCheckFailure(count = 1) {
      const by = usable(count);
      if (by !== undefined && by > 0) leakCheckFailures.inc(undefined, by);
    },

    recordAuthFailure(reason) {
      authFailures.inc({ reason });
    },

    recordForbidden(permission) {
      forbidden.inc({ permission });
    },

    recordRateLimitHit(limiter) {
      rateLimitHits.inc({ limiter });
    },

    recordInjectionFlag(source) {
      injectionFlags.inc({ source });
    },

    recordDbQuery(operation, durationMs) {
      const seconds = toSeconds(durationMs);
      if (seconds !== undefined) dbQueryDuration.observe(seconds, { operation });
    },

    recordRetrieval(provider, outcome, durationMs) {
      const seconds = toSeconds(durationMs);
      if (seconds !== undefined) retrievalDuration.observe(seconds, { provider, outcome });
    },

    recordSkillTransition(transition, outcome) {
      skillTransitions.inc({ transition, outcome });
    },
  };
}
