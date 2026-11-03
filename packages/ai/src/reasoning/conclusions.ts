import { MAX_CONCLUSIONS_UNDER_REVIEW } from '../context/focus';
import type { DeterministicFacts } from './facts';
import { TYPE_ORDER, findingKey } from './policy';
import { collectEventRefs } from './text';
import type { KeptProposal, ReviewConclusion } from './types';

const MAX_ENGINE_CONCLUSIONS = 8;
const MAX_ENGINE_FORKS = 4;
const MAX_ENGINE_RECOMMENDATIONS = 2;
const MAX_ENGINE_COUNTERFACTUALS = 2;

/** The headline conclusions of the engine: the leading hypothesis, its forks, its recommendations and counterfactuals. */
function engineConclusions(facts: DeterministicFacts): Omit<ReviewConclusion, 'id'>[] {
  const out: Omit<ReviewConclusion, 'id'>[] = [];
  const base = {
    source: 'engine' as const,
    reasoning: null,
    confidenceBasis: null,
    confidence: null,
    evidence: [],
  };
  const leading = facts.hypotheses[0];
  if (leading) {
    out.push({
      ...base,
      kind: 'leading_hypothesis',
      text: `Leading hypothesis: ${leading.name} (${leading.status}, likelihood ${leading.level}).`,
      eventIds: [],
      ref: `hypothesis:${leading.hypothesisId}`,
      confidence: leading.level,
    });
  }
  for (const fork of facts.forks.slice(0, MAX_ENGINE_FORKS)) {
    out.push({
      ...base,
      kind: 'fork',
      text: `Decision point: ${fork.title} (${fork.category.replace(/_/g, ' ')}).`,
      eventIds: [fork.eventId],
      ref: fork.id,
    });
  }
  for (const rec of facts.recommendations.slice(0, MAX_ENGINE_RECOMMENDATIONS)) {
    out.push({
      ...base,
      kind: 'recommendation',
      text: `Recommended: ${rec.label}`,
      eventIds: rec.eventIds.slice(0, 4),
      ref: rec.id,
    });
  }
  for (const cf of facts.counterfactuals.slice(0, MAX_ENGINE_COUNTERFACTUALS)) {
    out.push({
      ...base,
      kind: 'counterfactual',
      text: `Counterfactual at the decision: ${cf.label}`,
      eventIds: [cf.forkEventId],
      ref: cf.id,
    });
  }
  return out.slice(0, MAX_ENGINE_CONCLUSIONS);
}

/**
 * The numbered list of conclusions the critic reviews: the engine's headline conclusions first, then the reasoner's
 * validated proposals in a fixed order. Ids are `C1`, `C2`, ... and exist for this one critic call; each remembers what
 * it stands for so a critique can be attached to the right finding afterwards. The list is capped (the critic is not
 * asked to read more than it can answer); the proposals past the cap are findings all the same, without a second look.
 */
export function buildConclusions(
  facts: DeterministicFacts,
  proposals: readonly KeptProposal[],
): ReviewConclusion[] {
  const model = [...proposals].sort(
    (a, b) =>
      TYPE_ORDER[a.proposal.type] - TYPE_ORDER[b.proposal.type] ||
      findingKey(a).localeCompare(findingKey(b)),
  );
  const engine = engineConclusions(facts);
  const room = Math.max(0, MAX_CONCLUSIONS_UNDER_REVIEW - engine.length);
  const modelConclusions: Omit<ReviewConclusion, 'id'>[] = model.slice(0, room).map((kept) => ({
    source: 'model' as const,
    kind: kept.proposal.type,
    text: kept.proposal.statement,
    reasoning: kept.proposal.reasoning,
    confidenceBasis: kept.proposal.confidenceBasis,
    confidence: kept.proposal.confidence,
    eventIds: [...new Set(collectEventRefs(kept.proposal).map((r) => r.eventId))].slice(0, 8),
    evidence: kept.proposal.evidence.slice(0, 3),
    ref: kept.proposal.id,
  }));
  return [...engine, ...modelConclusions].map((c, i) => ({ ...c, id: `C${i + 1}` }));
}
