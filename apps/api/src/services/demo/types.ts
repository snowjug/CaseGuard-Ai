import type { DemoStep, SkillLifecycle } from '@caseguard/schemas';

/** What the tenant's stored data says about one of the two story cases. Plain data: no repositories. */
export interface CaseFacts {
  readonly id: string;
  readonly reference: string;
  /** The case's latest analysis completed. */
  readonly analyzed: boolean;
  readonly claimCount: number;
  readonly hypothesisCount: number;
  readonly forkCount: number;
  readonly earliestForkId: string | null;
  /** A scenario of the earliest meaningful fork that a reviewer accepted (`confirmed`). */
  readonly acceptedScenarioId: string | null;
  readonly qualityAssessed: boolean;
  readonly metricCount: number;
}

/** The skill the story produces: the skill derived from Case One. */
export interface SkillFacts {
  readonly id: string;
  readonly lifecycle: SkillLifecycle;
  /** A pilot approval and a publication on record, by two different people. */
  readonly governedPublication: boolean;
}

/** The stored match of the story skill on Case Two. */
export interface FollowUpMatchFacts {
  readonly applies: boolean;
  /** An engineer adopted the guided plan (the match then carries conformance). */
  readonly applied: boolean;
  readonly hasConformance: boolean;
}

/** Everything step progress is derived from. Built by `loadFacts`, consumed by `deriveSteps`. */
export interface DemoFacts {
  readonly caseOne: CaseFacts | null;
  readonly caseTwo: CaseFacts | null;
  readonly skill: SkillFacts | null;
  readonly followUpMatch: FollowUpMatchFacts | null;
}

/** The static part of a step; `completed`, `enabled` and the rest come from the facts. */
export interface StepSpec extends Pick<
  DemoStep,
  'id' | 'title' | 'description' | 'presenterNotes' | 'persona' | 'actionLabel'
> {
  /** The web route the primary action leads to, with the case and skill ids filled in once known. */
  readonly route: (facts: DemoFacts) => string;
  /** True when the stored facts show the step has happened. */
  readonly done: (facts: DemoFacts) => boolean;
}
