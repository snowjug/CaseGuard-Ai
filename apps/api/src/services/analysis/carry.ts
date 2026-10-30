import type { DeterministicAnalysis } from '@caseguard/domain';
import type { SkillLifecycle, SkillMatch } from '@caseguard/schemas';
import type { TenantRepositories } from '../../db';
import { withApplication } from '../skills/applied';
import type { AnalysisInputs } from './inputs';

/**
 * The current lifecycle state of the skills behind applied matches that the new analysis does not
 * match any more (deprecated or retired since, say), so their applications can be flagged with it.
 */
export async function withdrawnLifecycles(
  skills: Pick<TenantRepositories['skills'], 'get'>,
  previous: readonly SkillMatch[],
  fresh: readonly SkillMatch[],
): Promise<Map<string, SkillLifecycle>> {
  const present = new Set(fresh.map((match) => match.id));
  const lifecycles = new Map<string, SkillLifecycle>();
  for (const match of previous) {
    if (!match.applied || present.has(match.id) || lifecycles.has(match.skillId)) continue;
    const skill = await skills.get(match.skillId);
    if (skill !== null) lifecycles.set(skill.id, skill.lifecycle);
  }
  return lifecycles;
}

/**
 * A re-analysis recomputes every skill match from scratch, but who applied a skill to the case, and
 * when, is a fact the analysis cannot rediscover. The application is carried onto the new match, and
 * its conformance is recomputed on the new analysis (never copied): the stored match then reads the
 * same whether it is read straight from storage or through `skillMatches.list`.
 *
 * A skill that is no longer matchable (retired, say) has no new match to carry onto, but its
 * application is a human decision and part of the case's history: the stored match is kept as it was,
 * flagged by the skill's current lifecycle state so a reader can say the skill was withdrawn.
 */
export function carryApplications(args: {
  readonly fresh: readonly SkillMatch[];
  readonly previous: readonly SkillMatch[];
  readonly inputs: AnalysisInputs;
  readonly analysis: DeterministicAnalysis;
  /** Current lifecycle of the skills of applications that have no new match (`withdrawnLifecycles`). */
  readonly lifecycles?: ReadonlyMap<string, SkillLifecycle>;
}): SkillMatch[] {
  const { fresh, previous, inputs, analysis } = args;
  const applied = new Map(
    previous.filter((match) => match.applied).map((match) => [match.id, match]),
  );
  if (applied.size === 0) return [...fresh];

  const { events, caseRecord } = inputs;
  // The whole-case match is made as of the last recorded event, like `skillMatches.list` without `asOf`.
  const throughAt = events[events.length - 1]?.timestamp ?? caseRecord.openedAt;
  const carried = fresh.map((match) => {
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
  const present = new Set(fresh.map((match) => match.id));
  const withdrawn = [...applied.values()]
    .filter((match) => !present.has(match.id))
    .map((match) => ({
      ...match,
      lifecycle: args.lifecycles?.get(match.skillId) ?? match.lifecycle,
    }));
  return [...carried, ...withdrawn];
}
