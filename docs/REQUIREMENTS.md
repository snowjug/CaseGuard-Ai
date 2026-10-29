# Requirements

Requirement IDs are referenced from test names (for example `[FR-CF-03]`) so verification is traceable.
**Verification key:** U = unit · I = integration · E = end-to-end (Playwright) · A = automated accessibility · S = security test · M = documented manual check.

## 1. Functional requirements

### 1.1 Ingestion and digital twin

| ID         | Requirement                                                                                                                                                                                                      | Verif. |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-ING-01  | Ingest a case by pasting text, uploading a structured file, uploading a synthetic JSON bundle, or loading a built-in sample                                                                                      | U I E  |
| FR-ING-02  | Validate payloads against a versioned schema; show friendly field-level errors                                                                                                                                   | U I E  |
| FR-ING-03  | Preview normalized content, redaction summary and injection findings **before** analysis                                                                                                                         | I E    |
| FR-ING-04  | Redact secret-like and PII-like values (tokens, keys, connection strings, e-mail, IPs, phone) before persistence and before any model call                                                                       | U S    |
| FR-ING-05  | Reject unsupported file types, oversized payloads, wrong content types and malformed metadata                                                                                                                    | I S    |
| FR-ING-06  | Show ingestion progress and status                                                                                                                                                                               | E      |
| FR-ING-07  | Persist an immutable original-source record and immutable events (database-enforced)                                                                                                                             | I      |
| FR-ING-08  | Ingestion is idempotent for the same tenant + `Idempotency-Key` / content hash                                                                                                                                   | I      |
| FR-ING-09  | Offer downloadable JSON Schemas and example bundles                                                                                                                                                              | I E    |
| FR-TWIN-01 | Build a digital twin (problem, impact, environment, scope, timeline, participants, observations, actions, evidence, hypotheses, decisions, communications, escalations, resolution, validation, risks, unknowns) | U I    |
| FR-TWIN-02 | Every extracted field carries value, source reference, confidence, method, timestamp and review status                                                                                                           | U      |

### 1.2 Timeline and evidence

| ID       | Requirement                                                                                                                                                             | Verif. |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-TL-01 | Interactive chronological timeline with filters (event type, role, hypothesis, evidence class)                                                                          | E      |
| FR-TL-02 | Zoom into decision windows; open source evidence for any event                                                                                                          | E      |
| FR-TL-03 | Compare actual and simulated events on one axis                                                                                                                         | E      |
| FR-TL-04 | Highlight delays and repeated diagnostics                                                                                                                               | U E    |
| FR-TL-05 | Show hypothesis confidence over time and _what was known at each moment_                                                                                                | U E    |
| FR-TL-06 | **Future information never appears in a historical (`asOf`) window** — enforced server-side                                                                             | U I S  |
| FR-EV-01 | Classify claims as confirmed fact, customer-reported, engineer assumption, diagnostic evidence, AI inference, conflicting evidence, missing evidence, simulated outcome | U      |
| FR-EV-02 | Each ledger item shows claim, category, source, supporting/contradicting evidence, confidence, timestamp, hypothesis, reviewer status, explanation                      | I E    |
| FR-EV-03 | Reviewers can correct a classification; the original AI classification is preserved and the correction is audited                                                       | I E    |
| FR-EV-04 | Detect assumption-as-fact, unsupported root-cause claims and ignored contradictions                                                                                     | U      |

### 1.3 Hypotheses, forks, counterfactuals

| ID       | Requirement                                                                                                                                                                                                                           | Verif. |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-HY-01 | Maintain competing hypotheses with time-indexed, explainable confidence (model estimate, never "truth")                                                                                                                               | U      |
| FR-HY-02 | Per hypothesis: description, support, contradiction, missing evidence, assumptions, cheapest safe validating action, expected information gain, risk, customer effort, token estimate, status over time, promotion/demotion reason    | U I E  |
| FR-FK-01 | Detect the eight fork categories (alternative available, assumption as fact, contradiction ignored, low-value action, premature destructive action, premature escalation, disproportionate customer effort, high-value signal unused) | U      |
| FR-FK-02 | Each fork displays decision timestamp, information available/unavailable, actual action, alternatives with evidence, consequences, uncertainty, risk, counterfactual eligibility                                                      | I E    |
| FR-FK-03 | The earliest meaningful fork is highlighted                                                                                                                                                                                           | U E    |
| FR-CF-01 | Generate alternative investigation paths from a selected fork using **only** information available at the fork time                                                                                                                   | U I    |
| FR-CF-02 | Final resolution is never used as prior knowledge; every scenario records a leak-check result                                                                                                                                         | U I S  |
| FR-CF-03 | Scenarios label all outcomes as simulated, record assumptions and explicit uncertainty                                                                                                                                                | U E    |
| FR-CF-04 | Enforce safe-action restrictions (no destructive or approval-required actions recommended)                                                                                                                                            | U      |
| FR-CF-05 | Compare actual vs counterfactual on actions, customer interactions, time to useful evidence, time to diagnosis, volume, tokens, customer effort, risk, information gain, unsupported branches, confidence                             | U E    |
| FR-CF-06 | Reviewers can reject an unrealistic path with a reason (audited)                                                                                                                                                                      | I E    |
| FR-CF-07 | A post-hoc "hindsight check" may use the final resolution but is computed after generation, labelled, and never feeds generation                                                                                                      | U I    |
| FR-AV-01 | Rank candidate actions with a configurable, versioned, unit-normalized heuristic with visible calculation details                                                                                                                     | U      |
| FR-AV-02 | Show weight sensitivity and rank stability; allow reviewer override with reason                                                                                                                                                       | U I E  |
| FR-AV-03 | Never recommend unsafe/destructive actions because of a high score                                                                                                                                                                    | U      |

### 1.4 Quality, effort, live guidance, coaching

| ID        | Requirement                                                                                                                                      | Verif. |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------ |
| FR-QI-01  | Composite Case Quality Index with weights 25/20/15/15/15/10 and ten named penalties, each evidence-linked                                        | U      |
| FR-QI-02  | Show dimension scores, uncertainty, recommended improvements and estimated post-improvement score                                                | U E    |
| FR-ASE-01 | Avoidable Support Effort is an **estimate** with range, contributors, evidence, assumptions, method and actual-vs-counterfactual comparison      | U E    |
| FR-LQ-01  | Live quality warnings in five categories: specific, prioritized, evidence-linked, non-repetitive, dismissible with reason, auditable, actionable | U I E  |
| FR-LQ-02  | Warnings can be replayed as-of any time cursor                                                                                                   | U E    |
| FR-CO-01  | Generate a respectful, non-punitive coaching report with limitations                                                                             | U E    |

### 1.5 SkillDNA

| ID       | Requirement                                                                                                                            | Verif. |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-SK-01 | Extract draft SkillDNA (all required fields) from validated reasoning                                                                  | U I    |
| FR-SK-02 | Lifecycle: Discovered → Draft → Simulation Tested → Expert Reviewed → Pilot → Validated → Published → Deprecated → Retired             | U      |
| FR-SK-03 | AI-generated skills are never auto-published; transitions require the right role, a distinct approver, and an optimistic version check | U I S  |
| FR-SK-04 | Version history, human-readable diff, proposed mutation, rollback                                                                      | U I E  |
| FR-SK-05 | Match a published/validated skill to a new case using only evidence available at the match time                                        | U I E  |
| FR-SK-06 | Effectiveness metrics are derived from recorded applications and labelled synthetic where applicable                                   | U      |

### 1.6 Efficiency, analytics, governance

| ID       | Requirement                                                                                                                                                                                                                     | Verif. |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-TK-01 | Record prompt/completion/cached tokens, cost estimate, model, latency, context size/compression, cache hits, early stopping, savings, quality impact                                                                            | U I    |
| FR-TK-02 | Context selection, duplicate removal, evidence-first retrieval, semantic cache, model routing, per-agent budgets, retry limits, depth limits, circuit breaker, timeouts, env-configurable cost limits                           | U I    |
| FR-TK-03 | Simulated provider values are deterministic and labelled                                                                                                                                                                        | U E    |
| FR-AN-01 | Privacy-safe analytics: trends, evidence integrity, fork categories, missing evidence, avoidable effort, skill adoption/effectiveness, token efficiency, counterfactual acceptance, reviewer disagreement, frequent assumptions | I E    |
| FR-AN-02 | No individual employee ranking; responsible-use notice shown                                                                                                                                                                    | E M    |
| FR-GV-01 | Governance center: model config, prompt versions, scoring & action-value config, skill approvals, roles, audit viewer, retention, redaction, feature flags, export controls, demo reset, health, provider status                | I E    |
| FR-GV-02 | Configuration changes are versioned, audited and role-restricted                                                                                                                                                                | I S    |

### 1.7 Experience

| ID       | Requirement                                                                                                                                                                                                   | Verif. |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| FR-UX-01 | Twelve destinations: Command Center, Cases, Case Timeline, Evidence Ledger, Hypothesis Arena, Counterfactual Lab, Quality Review, SkillDNA Library, Efficiency Monitor, Governance, System Health, Demo Guide | E      |
| FR-UX-02 | Investigation graph with keyboard navigation, text alternative, zoom/focus, side panel, actual-vs-counterfactual comparison                                                                                   | E A    |
| FR-UX-03 | Dark/light themes with persistence, reduced motion, skeletons, empty/error/retry states, toasts, contextual help                                                                                              | E A    |
| FR-UX-04 | Command palette, global search, shortcuts, breadcrumbs, deep links, shareable filters                                                                                                                         | E      |
| FR-UX-05 | Confirmation for consequential actions; undo where appropriate                                                                                                                                                | E      |
| FR-UX-06 | Presentation mode with presenter notes, next-action highlight and reset; works with the deterministic provider only                                                                                           | E      |
| FR-UX-07 | Every metric card explains its definition and links to underlying evidence; nothing is presented as production data                                                                                           | E M    |

## 2. Non-functional requirements

| ID          | Requirement                                                                                                                                                 | Verif. |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| NFR-SEC-01  | Tenant isolation at the application layer **and** in the database (composite keys + RLS)                                                                    | I S    |
| NFR-SEC-02  | RBAC for Engineer, Reviewer, Manager, Skill Curator, Administrator; deny by default                                                                         | U I S  |
| NFR-SEC-03  | Development identity impossible in production; startup validation fails fast                                                                                | U S    |
| NFR-SEC-04  | Secure headers, CORS allowlist, request-size limits, content-type enforcement, rate limits, safe cookies, no stack traces in production                     | I S    |
| NFR-SEC-05  | Treat case content as untrusted: injection detection, instruction/data separation, tool restriction, citation validation, schema validation, bounded tokens | U I S  |
| NFR-SEC-06  | No secrets in the repository; secret scanning in CI and pre-commit                                                                                          | M      |
| NFR-SEC-07  | Append-only, hash-chained audit log for security-relevant and AI actions                                                                                    | U I    |
| NFR-PRIV-01 | Redaction before persistence/model calls; retention controls; privacy-safe analytics                                                                        | U I M  |
| NFR-A11Y-01 | WCAG 2.2 AA goals: keyboard, focus visibility, contrast, landmarks, labels, announcements, reduced motion, chart/graph text alternatives, touch targets     | A M    |
| NFR-PERF-01 | Paginated lists; bounded graph; virtualised long timelines; measured (not invented) benchmarks                                                              | I      |
| NFR-OBS-01  | Structured logs with correlation IDs and redaction, request/model/token/error metrics, liveness/readiness/dependency health, OpenTelemetry readiness        | I      |
| NFR-REL-01  | Bounded retries, timeouts, circuit breaker, cancellation, idempotent writes, transactions, optimistic locking                                               | U I    |
| NFR-COST-01 | Cost-conscious defaults, scale-to-zero, budgets, no hard-coded prices                                                                                       | M      |
| NFR-DX-01   | One-command start, test, reset and demo seed; `.env.example` with fail-fast validation                                                                      | M      |
| NFR-AZ-01   | Bicep IaC that builds and lints; managed identity preferred; Key Vault; monitoring; no public unrestricted data services                                    | M      |
