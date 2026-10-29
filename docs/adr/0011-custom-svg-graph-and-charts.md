# ADR 0011: Custom SVG investigation graph and charts instead of a charting library

- Status: Accepted
- Date: 2026-10-29
- Deciders: project owner and architect

## Context

The UI needs an investigation graph (evidence, hypotheses, decision forks, actual versus counterfactual paths)
and a handful of metric charts. Requirements demand keyboard navigation, text alternatives, zoom and focus,
and WCAG 2.2 AA behaviour for charts and graphs (FR-UX-02, NFR-A11Y-01), plus theming with the shared design
tokens and a presentation mode. Every metric must explain its definition and link to evidence (FR-UX-07).

## Decision

Implement the graph and charts in `packages/ui` as **purpose-built, accessible React SVG components** driven by
the design tokens, not with a charting or graph-visualisation library. Each component exposes a semantic
structure (roles, labels, focus order), a text or table alternative for the same data, reduced-motion behaviour
and light/dark themes, and must be covered by unit tests and by axe checks in the end-to-end suite. Layout is
deterministic so screenshots and tests are stable.

## Consequences

- Good: full control of keyboard and screen-reader behaviour; no heavy dependency or its release cadence in the
  supply chain; small bundles; the same tokens style charts and the rest of the UI; deterministic rendering.
- Bad: we own the maintenance: layout, zoom, hit-testing and edge cases that a library already solved; fewer
  chart types and less polish out of the box; every new visualisation costs real work and needs accessibility
  testing.
- Bad: no library community to lean on for bugs; large graphs need explicit bounds and pagination (NFR-PERF-01)
  rather than relying on library virtualisation.

## Alternatives considered

- **A charting library (for example Recharts, Chart.js, visx):** quick, but accessibility of the output is
  usually partial and hard to correct from outside, and the graph still needs custom work.
- **A graph library (for example Cytoscape, React Flow, D3 force layouts):** powerful, but canvas or complex
  DOM output is difficult to make keyboard-operable and to describe in text, and layouts are not deterministic.
- **Fluent UI data-visualisation components:** considered for charts; they do not cover the investigation
  graph, and a single custom approach keeps behaviour consistent.

## Notes

Reconsider for a chart type that would take more effort than its value, as long as it can meet the same
accessibility bar.
