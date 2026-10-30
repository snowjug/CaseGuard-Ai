import type { DeterministicAnalysis } from '@caseguard/domain';
import type { SkillMatch } from '@caseguard/schemas';
import { withApplication } from '../skills/applied';
import type { AnalysisInputs } from './inputs';

/**
 * A re-analysis recomputes every skill match from scratch, but who applied a skill to the case, and
 * when, is a fact the analysis cannot rediscover. The application is carried onto the new match, and
 * its conformance is recomputed on the new analysis (never copied): the stored match then reads the
 * same whether it is read straight from storage or through `skillMatches.list`.
 *
 * A skill that is no longer matchable (retired, say) has no new match to carry onto.
 */
export function carryApplications(args: {
  readonly fresh: readonly SkillMatch[];
  readonly previous: readonly SkillMatch[];
  readonly inputs: AnalysisInputs;
  readonly analysis: DeterministicAnalysis;
}): SkillMatch[] {
  const { fresh, previous, inputs, analysis } = args;
  const applied = new Map(
    previous.filter((match) => match.applied).map((match) => [match.id, match]),
  );
  if (applied.size === 0) return [...fresh];

  const { events, caseRecord } = inputs;
  // The whole-case match is made as of the last recorded event, like `skillMatches.list` without `asOf`.
  const throughAt = events[events.length - 1]?.timestamp ?? caseRecord.openedAt;
  return fresh.map((match) => {
    const before = applied.get(match.id);
    const entry = inputs.skills.find((candidate) => candidate.skill.id === match.skillId);
    if (before === undefined || entry === undefined) return match;
    return withApplication({
      fresh: match,
      before,
      entry,
      analysis,
      pack: inputs.pack,
      config: inputs.actionConfig,
      caseId: caseRecord.id,
      throughAt,
    });
  });
}
