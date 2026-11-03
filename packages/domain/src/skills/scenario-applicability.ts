import type {
  CounterfactualScenario,
  ScenarioSkillApplicability,
  SkillMatch,
} from '@caseguard/schemas';
import { APPLIES_THRESHOLD, PARTIAL_THRESHOLD } from './matching';

type MatchForPath = Pick<
  SkillMatch,
  | 'skillId'
  | 'skillName'
  | 'applicability'
  | 'matchedTriggers'
  | 'unmatchedTriggers'
  | 'exclusionsHit'
  | 'recommendedSteps'
>;

export interface PathForSkills {
  readonly boundary: { readonly evidenceIds: readonly string[] };
  readonly steps: readonly { readonly actionKey: string }[];
}

/**
 * Whether a governed skill would have helped at the decision moment of a counterfactual path (wave 2). A trigger counts only
 * when every piece of evidence it rests on was already recorded then; a trigger with no evidence behind it is not counted,
 * so the answer errs toward "no". A skill covers the path when it recommends the path's first step. Nothing here changes
 * the path or any figure of it.
 */
export function skillApplicabilityFor(
  path: PathForSkills,
  matches: readonly MatchForPath[],
): ScenarioSkillApplicability {
  const known = new Set(path.boundary.evidenceIds);
  const firstKey = path.steps[0]?.actionKey ?? null;
  const rated = matches
    .filter((match) => match.applicability !== 'not_applicable' && match.exclusionsHit.length === 0)
    .map((match) => {
      const total =
        match.matchedTriggers.reduce((sum, trigger) => sum + trigger.weight, 0) +
        match.unmatchedTriggers.reduce((sum, trigger) => sum + trigger.weight, 0);
      const held = match.matchedTriggers
        .filter(
          (trigger) =>
            trigger.evidenceIds.length > 0 && trigger.evidenceIds.every((id) => known.has(id)),
        )
        .reduce((sum, trigger) => sum + trigger.weight, 0);
      return {
        skillId: match.skillId,
        name: match.skillName.slice(0, 160),
        triggerCoverage: total > 0 ? Math.round((held / total) * 1000) / 1000 : 0,
        recommendsFirstStep:
          firstKey !== null && match.recommendedSteps.some((step) => step.actionKey === firstKey),
      };
    })
    .filter((rating) => rating.triggerCoverage >= PARTIAL_THRESHOLD)
    .sort((a, b) => b.triggerCoverage - a.triggerCoverage || a.skillId.localeCompare(b.skillId))
    .slice(0, 5);

  if (rated.length === 0) {
    return {
      status: 'no_matching_skill',
      skills: [],
      note: 'No governed skill resembled the case with what was recorded at that moment.',
    };
  }
  const covering = rated.find(
    (rating) => rating.triggerCoverage >= APPLIES_THRESHOLD && rating.recommendsFirstStep,
  );
  if (covering) {
    return {
      status: 'applies',
      skills: rated,
      note: `“${covering.name}” already matched at that moment and recommends the same first step as this path.`,
    };
  }
  return {
    status: 'partially_applies',
    skills: rated,
    note: 'A skill resembled the case at that moment, but it does not recommend the first step of this path or only part of its triggers held.',
  };
}

/** The scenario with its skill applicability set. A scenario without a quality block is returned unchanged. */
export function withSkillApplicability(
  scenario: CounterfactualScenario,
  matches: readonly MatchForPath[],
): CounterfactualScenario {
  if (scenario.quality === undefined) return scenario;
  return {
    ...scenario,
    quality: { ...scenario.quality, skillApplicability: skillApplicabilityFor(scenario, matches) },
  };
}
