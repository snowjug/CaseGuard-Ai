import {
  checkConformance,
  toMatchConformance,
  type AnalysisAsOf,
  type CompiledPack,
  type MatchableSkill,
} from '@caseguard/domain';
import type { ActionValueConfig, SkillMatch } from '@caseguard/schemas';

/**
 * A freshly computed match for a case where an engineer already applied the skill. The application
 * is a fact about the case, so it is kept (who, when), and its conformance is recomputed from the
 * events known through `throughAt` against the skill's current version: the same function that
 * computed it when the application was recorded, so a re-analysis and a later read agree.
 */
export function withApplication(args: {
  readonly fresh: SkillMatch;
  readonly before: SkillMatch;
  readonly entry: MatchableSkill;
  readonly analysis: AnalysisAsOf;
  readonly pack: CompiledPack;
  readonly config: ActionValueConfig;
  readonly caseId: string;
  readonly throughAt: string;
}): SkillMatch {
  const { fresh, before, entry } = args;
  return {
    ...fresh,
    applied: true,
    appliedAt: before.appliedAt,
    appliedBy: before.appliedBy,
    conformance: toMatchConformance(
      checkConformance({
        version: entry.version,
        analysis: args.analysis,
        pack: args.pack,
        config: args.config,
        caseId: args.caseId,
        appliedAt: before.appliedAt,
        throughAt: args.throughAt,
      }),
    ),
  };
}
