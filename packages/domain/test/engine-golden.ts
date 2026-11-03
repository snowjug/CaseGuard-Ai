import {
  DEFAULT_QUALITY_CONFIG,
  COUNTERFACTUAL_STRATEGIES,
  type CaseWarning,
  type CoachingReport,
  type CounterfactualScenario,
  type DigitalTwin,
  type MetricEstimate,
  type QualityAssessment,
} from '@caseguard/schemas';
import {
  buildCoachingReport,
  buildDigitalTwin,
  buildMetricEstimates,
  computeAvoidableEffort,
  computeEfficiency,
  computeQualityReview,
  generateCounterfactuals,
  hashJson,
  replayWarnings,
  type DeterministicAnalysis,
} from '../src';
import { CONFIG, type Prepared } from './helpers';

/** Everything the application stores for a case, computed in the order `computeAnalysis` computes it. */
export interface CaseComputation {
  readonly analysis: DeterministicAnalysis;
  readonly twin: DigitalTwin;
  readonly scenarios: CounterfactualScenario[];
  readonly review: QualityAssessment;
  readonly metrics: MetricEstimate[];
  readonly warnings: CaseWarning[];
  readonly coaching: CoachingReport;
}

/** The same orchestration as `apps/api/src/services/analysis/compute.ts`, without skills or a database. */
export function computeCase(prepared: Prepared): CaseComputation {
  const { normalized, pack, ctx, analysis } = prepared;
  const { events, resolution } = normalized;
  const twin = buildDigitalTwin({
    caseRecord: normalized.case,
    events,
    resolution,
    analysis,
    pack,
    ctx,
    asOf: null,
  });
  const eligible = analysis.forks.filter((fork) => fork.eligibility.eligible);
  const ordered = [
    ...eligible.filter((fork) => fork.isEarliestMeaningful),
    ...eligible.filter((fork) => !fork.isEarliestMeaningful),
  ].slice(0, 12);
  const scenarios = ordered.flatMap(
    (fork) =>
      generateCounterfactuals({
        analysis,
        fork,
        strategies: fork.isEarliestMeaningful ? COUNTERFACTUAL_STRATEGIES : ['balanced'],
        events,
        resolution,
        pack,
        config: CONFIG,
        ctx,
      }).scenarios,
  );
  const review = computeQualityReview({
    analysis,
    pack,
    ctx,
    config: DEFAULT_QUALITY_CONFIG,
    actionConfig: CONFIG,
  });
  const avoidable = computeAvoidableEffort({ analysis, pack, scenarios });
  const efficiency = computeEfficiency({
    analysis,
    pack,
    caseId: normalized.case.id,
    synthetic: normalized.case.synthetic,
    unitPrices: { inputPer1kUsd: null, outputPer1kUsd: null, cachedInputPer1kUsd: null },
    avoidable,
  });
  const metrics = buildMetricEstimates({
    analysis,
    pack,
    ctx,
    review,
    avoidable,
    efficiency,
    synthetic: normalized.case.synthetic,
    actionConfig: CONFIG,
  });
  const replay = replayWarnings({ events, resolution, pack, ctx, config: CONFIG, analysis });
  const coaching = buildCoachingReport({
    analysis,
    pack,
    ctx,
    review,
    warnings: replay.warnings,
    skills: [],
    config: CONFIG,
    synthetic: normalized.case.synthetic,
  });
  return { analysis, twin, scenarios, review, metrics, warnings: replay.warnings, coaching };
}

const LOCATION_KEYS: ReadonlySet<string> = new Set(['pointer', 'field', 'start', 'end']);
/** Objects (or lists of objects) that say where in the stored text a value was found. */
const LOCATED_KEYS: ReadonlySet<string> = new Set(['sourceRef', 'sourceRefs', 'observation']);

const withoutLocation = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutLocation)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).filter(([name]) => !LOCATION_KEYS.has(name)))
      : value;

/**
 * What a change that only adds source linkage may move. A source reference says where in the stored
 * text a value was found (`pointer`, `field`, `start`, `end`); a recommendation lists the things that
 * justify it (`evidence`). Neither takes part in any score, ranking, id or text, so a comparison that
 * leaves them out proves the rest did not move.
 */
export function withoutLinkage(value: unknown, links: boolean): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutLinkage(item, links));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (links && key === 'evidence' && Array.isArray(inner)) continue;
    out[key] = withoutLinkage(LOCATED_KEYS.has(key) ? withoutLocation(inner) : inner, links);
  }
  return out;
}

/** What the scenario annotations are called: they describe a path and are never part of what it computes. */
const SCENARIO_ANNOTATIONS: ReadonlySet<string> = new Set(['quality', 'feasibility']);

const withoutAnnotations = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutAnnotations)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([name]) => !SCENARIO_ANNOTATIONS.has(name))
            .map(([name, inner]) => [name, withoutAnnotations(inner)]),
        )
      : value;

/** One digest per part of a case, so a failure names the part that moved. */
export function linkageFreeDigests(c: CaseComputation): Record<string, string> {
  const { analysis } = c;
  const part = (value: unknown, links: boolean): string => hashJson(withoutLinkage(value, links));
  return {
    evidence: part(analysis.evidence, false),
    claims: part(analysis.claims, false),
    hypotheses: part(analysis.hypotheses, false),
    hypothesisLinks: part(analysis.links, false),
    missing: part(analysis.missing, false),
    actions: part(analysis.actions, false),
    forks: part(analysis.forks, false),
    timeline: part(analysis.timeline, false),
    twin: part(c.twin, false),
    // The paths without the annotations that say how far to trust them: describing a path moves no figure of it.
    scenarios: part(withoutAnnotations(c.scenarios), false),
    scenarioQuality: part(
      c.scenarios.map((s) => ({
        id: s.id,
        quality: s.quality,
        feasibility: s.steps.map((step) => step.feasibility),
      })),
      false,
    ),
    quality: part(c.review, true),
    metrics: part(c.metrics, true),
    warnings: part(c.warnings, true),
    coaching: part(c.coaching, true),
  };
}
