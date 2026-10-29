# @caseguard/observability

Structured logging with absolute redaction, request correlation, in-process metrics, tracing hooks,
health aggregation and privacy-safe product telemetry. Everything is injectable (clock, ids,
randomness, redactor) and nothing is global: create one logger, one `MetricsRegistry` and one
`HealthRegistry` at startup and pass them down. The package never calls `console.*` and does not
import `@caseguard/security`; an injected `redact(text)` is applied on top of the built-in redactor.

## Wiring (API layer)

```ts
import {
  bindMetricsToOtel,
  correlationResponseHeaders,
  createLogger,
  createMetricsRegistry,
  createProductMetrics,
  createRequestContext,
  HealthRegistry,
  PROMETHEUS_CONTENT_TYPE,
  runWithContext,
  setContextValue,
} from '@caseguard/observability';

const logger = createLogger({ service, version, env, level, commit, redact: securityRedact });
const registry = createMetricsRegistry();
const metrics = createProductMetrics(registry, { service, version, commit });
const health = new HealthRegistry({ service, version, commit, environment: env });
health.registerStandard('database', async ({ signal }) => {
  await database.ping(signal);
});

app.addHook('onRequest', (request, reply, done) => {
  const context = createRequestContext({ headers: request.headers });
  runWithContext(context, () => {
    void reply.headers(correlationResponseHeaders());
    done();
  });
});
// after authentication: setContextValue('tenantId', principal.tenantId); setContextValue('userId', ...)
// onResponse: metrics.recordHttpRequest({ method, route: request.routeOptions.url, statusCode, durationMs })
// GET /metrics: reply.type(PROMETHEUS_CONTENT_TYPE).send(registry.renderPrometheus())
// GET /livez: health.liveness()   GET /readyz: health.readiness() then reply.code(report.httpStatus)

// Call after the OpenTelemetry SDK has started; it is a no-op while only the API no-op meter exists.
const otel = bindMetricsToOtel(registry);
```

Outgoing calls: spread `propagationHeaders()` into the request headers so the downstream service joins
the trace. Wrap work in `withSpan(name, attributes, fn)`; it is free without an SDK.

## Redaction

Four layers, so one miss does not leak: (1) a deep scrub of every logged object (credential and PII
key names at any depth, token and connection-string shapes inside strings, error stacks and `cause`
chains, hostile objects such as throwing getters); (2) the `msg` serialiser; (3) `child()` bindings;
(4) pino `redact` paths for headers and credential fields. Covered shapes: bearer and basic auth
values, JWTs, `Server=...;Password=...` style connection strings, URL credentials, SAS `sig=`,
`AccountKey=`, provider API keys, PEM blocks, cookies, emails, SSNs, payment cards and user home
paths. Stacks are omitted when `env` is `production`.

Limits: pattern redaction is best effort. Free text that merely resembles prose cannot be recognised
as sensitive, so never log case content, prompts or model output. Strings are truncated (4096
characters by default) and one `value()` call has a total character budget.

## Metrics

All names carry the `caseguard_` prefix and are listed in `METRIC_NAMES`. Each label has a cardinality
budget (50 distinct values, 200 for `route`); extra values fold into `other` and are counted in
`caseguard_metrics_label_overflow_total`.

| Metric                                                                                            | Type               | Labels                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| `http_requests_total`, `http_request_duration_seconds`                                            | counter, histogram | `method`, `route`, `status_class`                                                        |
| `errors_total`                                                                                    | counter            | `component`, `code`                                                                      |
| `jobs_active`, `queue_depth`                                                                      | gauge              | `kind`; `queue`                                                                          |
| `job_duration_seconds`, `job_failures_total`                                                      | histogram, counter | `kind`, `status`; `kind`, `reason`                                                       |
| `model_calls_total`                                                                               | counter            | `agent`, `provider`, `status`                                                            |
| `model_tokens_total`                                                                              | counter            | `agent`, `provider`, `direction` (input, output, cached), `source` (measured, estimated) |
| `model_call_duration_seconds`                                                                     | histogram          | `agent`, `provider`                                                                      |
| `model_cache_lookups_total`, `model_cache_hit_ratio`                                              | counter, gauge     | `result`; none                                                                           |
| `model_fallbacks_total`, `model_validation_failures_total`                                        | counter            | `agent`, `reason`; `agent`, `kind`                                                       |
| `analysis_duration_seconds`                                                                       | histogram          | `outcome`                                                                                |
| `counterfactual_leak_check_failures_total`                                                        | counter            | none; must stay 0 and renders 0 from the start                                           |
| `auth_failures_total`, `forbidden_total`, `rate_limit_hits_total`, `prompt_injection_flags_total` | counter            | `reason`; `permission`; `limiter`; `source`                                              |
| `db_query_duration_seconds`, `retrieval_duration_seconds`                                         | histogram          | `operation`; `provider`, `outcome`                                                       |
| `skill_transitions_total`                                                                         | counter            | `transition`, `outcome`                                                                  |
| `build_info`, `process_start_time_seconds`                                                        | gauge              | `service`, `version`, `commit`; none                                                     |

Use route patterns (`/api/v1/cases/:caseId`) for `route`, never raw URLs. `buildRequestMetrics`
turns a snapshot into the `RequestMetrics` DTO (percentiles are bucket-interpolated estimates, and
"errors" means 5xx). OpenTelemetry instrument names equal the Prometheus names, except counters lose
the `_total` suffix.

## Health

`liveness()` never touches a dependency. `readiness()` runs the registered checks in parallel, each
with a timeout (2 s default) and a cached result (5 s default, failures included, concurrent calls
share one execution). It reports `down` and `ready: false` (HTTP 503) only when a critical check
(`database`, `migrations`) is down; other failures yield `degraded`. `detail: 'minimal'` omits error
text for unauthenticated probes. `systemHealth()` returns the `SystemHealth` DTO from
`@caseguard/schemas`; native states map `up` to `healthy`, `degraded` to `degraded` and `down` to
`unhealthy`. Error messages are scrubbed, one line and stack free.

## Honest limits

Validated with fakes: a recording tracer, a fake OpenTelemetry meter and in-memory destinations. The
Fastify wiring above, a live OpenTelemetry SDK and Azure Monitor or Application Insights are not
exercised by this package's tests. Exposing `/metrics` (and who may scrape it) is a decision for the
API layer.
