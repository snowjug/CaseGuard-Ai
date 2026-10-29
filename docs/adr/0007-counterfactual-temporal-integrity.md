# ADR 0007: Counterfactual temporal integrity enforced by a branded TemporalView

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The platform simulates what a safer or shorter investigation would have done at a decision point. That claim is
worthless if the simulation can see information that only existed later, above all the final resolution
(principle 3, AI-3). Hindsight leaks are easy to introduce (a convenience helper that reads the whole case) and
hard to see in review. Convention alone is not enough.

## Decision

- **A single gatekeeper produces a branded `TemporalView`.** It takes a case and an as-of time T and returns a
  value of a branded TypeScript type that contains only events, evidence and facts with a known-at time at or
  before T, and never the resolution. Every analysis function (evidence classification, hypothesis updates,
  action value, forks, counterfactual generation) accepts **only** a `TemporalView`; the type system makes
  passing a raw case a compile error.
- **As-of is enforced server-side.** Routes derive the boundary from stored data and the request, not from
  trusted client input; citation validation also rejects ids that are not in the view (ADR 0005).
- **Leak check per scenario.** Each counterfactual scenario records the result of a leak check that proves its
  inputs came from a view at or before the decision time.
- **Hindsight is separate.** Comparing a simulation with what actually happened is a distinct, clearly labelled
  step that runs after generation and never feeds back into it. Customer response latency in simulations uses a
  configured prior with a range (A-09), never the observed future reply time.
- **Metamorphic and property tests** (fast-check) mutate or append future events and assert that the output for
  time T is unchanged. These tests are part of the definition of done for any analysis change.

## Consequences

- Good: a leak is a compile error or a failing property test rather than a review catch; each scenario carries
  auditable evidence of integrity.
- Bad: every new analysis feature must be written against `TemporalView` and cannot take shortcuts; the
  gatekeeper becomes security-critical code and needs the strictest review.
- Bad: brands are erased at runtime, so untyped code paths (for example JSON input) must go through the
  gatekeeper too; the property tests guard that boundary.

## Alternatives considered

- **Documentation and code review only:** does not scale and fails silently.
- **Runtime assertions in each function:** easy to forget and cannot prevent the call.
- **Separate processes or databases per time slice:** heavy, and it does not prove the right filter was applied.
- **Redacting the resolution at ingestion:** the resolution is needed for hindsight comparison and scoring.
