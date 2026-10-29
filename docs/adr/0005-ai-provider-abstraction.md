# ADR 0005: Model provider abstraction; "LLM proposes, code disposes"

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The product must be demonstrable without a model endpoint, must never persist unvalidated model output, and
must be honest about what is estimated. Model output is untrusted (prompt injection in case text, forged
citations, unsafe recommendations: AI-1, AI-2, AI-5) and costs money (T9).

## Decision

- A **`ModelProvider`** interface with two implementations: a **deterministic knowledge-pack provider** (the
  default, no network, fully reproducible; token counts are estimated as `ceil(chars / 4)` and costs are
  simulated, never billed: A-07) and an **Azure OpenAI provider** (managed identity by default; an API key is
  allowed only for local experiments).
- **The LLM proposes, code disposes.** Probability updates, scoring, safety policy, citation checks and
  persistence validation are deterministic code. A proposal is persisted only after (1) schema validation,
  (2) citation validation (every cited event or evidence id must exist in the same tenant and case at or before
  the temporal boundary) and (3) safety-policy validation. Instructions and case data are structurally
  separated and the model has no tools.
- **Governors and budgets**: per-agent input/output token limits, timeouts, bounded retries, a circuit
  breaker, an optional daily cost cap and operator-supplied unit prices (never hard-coded: A-16).
- **Honest validation status.** The Azure OpenAI path implements the same contract. The implementation plan
  validates it with contract tests against a local mock of the REST API; it has **not** been validated against a
  live deployment, and the UI, API and docs say so. Pack-derived numbers are illustrative estimates authored for
  the demo (A-06).

## Consequences

- Good: the demo works offline; a model cannot write directly to the system of record; one validation pipeline
  covers both providers; cost and failure modes are bounded.
- Bad: the deterministic provider is rule-based and only strong on bundled knowledge packs; injection heuristics
  are pattern-based and can be evaded (Azure AI Content Safety Prompt Shields are on the roadmap, not
  implemented); provider differences are only visible once a live deployment is tested.

## Alternatives considered

- **Model-only analysis:** nondeterministic, hard to test, and no guarantee that citations exist.
- **Deterministic-only:** safest, but cannot read free text the pack does not anticipate.
- **A heavy agent framework with tools:** more attack surface and more nondeterminism than the problem needs.

## Notes

Prompts are versioned; see `packages/ai`. Threats and mitigations: `docs/THREAT_MODEL.md` section 4.
