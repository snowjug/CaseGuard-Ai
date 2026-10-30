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

## Request spans

`startServerSpan({ method, route, routeId, requestId, traceparent, tracestate })` starts the SERVER span
of an inbound request. While no OpenTelemetry SDK is registered (`hasTracerProvider()`) it returns
`undefined` and does nothing else, so it can run on every request. The span is named
`<METHOD> <routeId | route pattern | unmatched>` and carries only the attributes of
`SERVER_SPAN_ATTRIBUTES` (`http.request.method`, `http.route`, `http.response.status_code`,
`cg.request_id`, `cg.route_id`); the input has no URL field, and a route that is not a plain pattern
(a query, a fragment, whitespace, an absolute URL) is ignored. A valid inbound `traceparent` becomes
the remote parent; a malformed one is ignored. The returned handle has `run(fn)` (makes the span
active), `captureError(error)` (remembered, and recorded scrubbed and without a stack only if the
request ends 5xx) and `end(statusCode?)` (ends the span once). The span's ids are also written to the
request context, so log lines and `propagationHeaders()` match the exported trace even when the SDK
has no context manager. The Fastify adapter is `registerTracing` in `apps/api/src/http/tracing.ts`.

`safeErrorCode(error)` returns the `code` or `name` of an error when it is identifier-like, never its
message: use it to report failures of calls whose messages can echo secrets, such as a connection string.

## Test doubles

`@caseguard/observability/testing` (not part of the production entry point) registers stand-ins for the
SDK as the OpenTelemetry globals: `installInMemoryTracing()` (an in-memory tracer provider with
deterministic ids and an async context manager) and `installRecordingMeter()` (a meter that records
every instrument and measurement). Both return a handle whose `uninstall()` belongs in `afterEach`.

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

Validated with fakes: an in-memory tracer, a recording OpenTelemetry meter and in-memory destinations.
The API's Fastify wiring is covered by `apps/api` tests that use those fakes. A live OpenTelemetry SDK
was exercised once, by hand, against a loopback stand-in for the Azure Monitor ingestion endpoint (see
`docs/OBSERVABILITY.md`, section 9); Azure Monitor and Application Insights themselves have never been
observed. Exposing `/metrics` (and who may scrape it) is a decision for the API layer.
