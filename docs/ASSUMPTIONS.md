# Assumptions

Assumptions made while the requirements were silent or ambiguous. Each can be revisited; the **Impact** column says what would change.

| ID | Assumption | Rationale | Impact if wrong |
| --- | --- | --- | --- |
| A-01 | The hackathon audience evaluates a working local demo; no live Azure subscription is guaranteed | Credentials were not supplied; deploying costs money | Azure paths are implemented and statically validated only; documented as such |
| A-02 | All case data is synthetic; synthetic bundles carry `"synthetic": true` and the UI labels them | Privacy and the explicit instruction not to use customer data | Non-synthetic uploads are accepted only after redaction and are flagged `synthetic=false` |
| A-03 | One logical tenant is seeded (`tenant_contoso_support`) and a second (`tenant_fabrikam_lab`) exists for isolation tests | Tenant isolation must be demonstrable | Single-tenant deployments simply use one tenant row |
| A-04 | Hypotheses are modelled as mutually exclusive plus an explicit "other / unknown" mass | Keeps Bayesian updating explainable | Co-occurring causes are under-represented; documented limitation |
| A-05 | Evidence signals are treated as conditionally independent, dampened by a per-signal weight | Naive-Bayes style updating is transparent and testable | Correlated signals can over-weight a hypothesis; mitigated by dampening and uncertainty bands |
| A-06 | Likelihoods, priors, effort and cost figures in the knowledge pack are **illustrative estimates authored for the demo**, not Microsoft guidance or measured data | No authoritative dataset exists | Output confidences are model estimates only and are always labelled so |
| A-07 | Token counts for the deterministic provider are estimated as `ceil(chars / 4)` and costs are simulated, never billed | Honest, deterministic telemetry without a live model | Real numbers appear only when the Azure provider is configured |
| A-08 | Time-to-diagnosis for the actual path is the first moment the leading hypothesis posterior reaches the configured threshold (default 0.75) using only evidence available then | A defensible, reproducible definition | Threshold is configurable (governance) |
| A-09 | Customer response latency in counterfactual simulation uses a configured prior (default 90 minutes, range 45–180), never the observed future reply time | Prevents temporal leakage | Estimates are labelled as assumptions with ranges |
| A-10 | The skill-guided second case is an authored synthetic case; improvement figures demonstrate the measurement pipeline, not real-world effectiveness | There is no real population of engineers | UI and docs carry an explicit synthetic-effectiveness notice |
| A-11 | PGlite is acceptable for local/test persistence; production uses PostgreSQL | Removes Docker as a hard prerequisite | CI also runs the integration suite on real PostgreSQL |
| A-12 | A single-process in-memory job runner is sufficient (no external queue) | Modular monolith; bounded workloads | Horizontal scale would need a queue (documented in roadmap) |
| A-13 | Rate limiting and caching are in-memory; Redis is optional and disabled by default | Cost-conscious defaults | Multi-replica deployments need Redis-backed limits (flagged in docs) |
| A-14 | Development persona authentication is only available when `APP_ENV` is `local` or `test` | Prevents accidental insecure production deploys | Startup refuses to run otherwise |
| A-15 | Microsoft Entra ID integration validates JWTs and maps app roles; it has not been exercised against a live tenant here | No tenant/credentials available | Documented setup steps; unit-tested with locally generated keys |
| A-16 | Pricing is never hard-coded; cost figures in the product are token-based estimates from configurable unit prices | Azure pricing varies by region, date, agreement and SKU | Operators must supply current prices |
| A-17 | Time zones: all timestamps are stored and compared in UTC | Avoids the ambiguity that plagues log correlation | UI renders in the viewer's locale with explicit UTC offsets |
| A-18 | The repository is initially empty and the first push would create the default branch | Observed via `gh repo view` | A base branch must be approved before a PR can be opened |
