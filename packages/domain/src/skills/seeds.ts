import { generateCounterfactuals } from '../engine/pipeline';
import {
  extractSkillCandidates,
  type ExtractionRefusal,
  type SkillDraft,
  type SkillExtractionInput,
} from './extraction';
import { proposeMutations, type MutationProposal, type MutationSourceCase } from './mutation';
import {
  skillFail,
  skillOk,
  type SkillActor,
  type SkillOpContext,
  type SkillResult,
} from './types';

/** One synthetic case as the seed sees it (the same inputs the analysis pipeline already produced). */
export type SeedCase = MutationSourceCase;

export interface SeedSkillsInput {
  /** The case the base skill is distilled from (DNS root cause in the synthetic data). */
  caseOne: SeedCase;
  /** A related case whose different root cause (proxy) extends the skill through a mutation. */
  caseTwo: SeedCase;
  /** Who proposes the mutation: needs skill:mutate. */
  proposer: SkillActor;
  op: SkillOpContext;
  rolloutCount?: number;
}

export interface SeedSkills {
  /** The extracted draft: lifecycle `discovered`, version 1.0.0, never published by the seed. */
  draft: SkillDraft;
  forkId: string;
  scenarioId: string;
  /** Pass this to `proposeMutations` against the up-to-date skill (for example once it is published). */
  mutationSource: MutationSourceCase;
  /** The proposal computed against the fresh draft, for previews; it is `proposed`, never applied. */
  previewMutation: MutationProposal | null;
  refusals: ExtractionRefusal[];
}

/**
 * Pure and deterministic: derives the two demo skills from the two synthetic cases. Case One yields the
 * "isolate a pre-authentication failure before pursuing identity policy" skill through its earliest
 * eligible fork; Case Two yields a mutation proposal with the proxy-node step, the timeout trigger and
 * the per-node PowerShell timing template. Both start unreviewed: governance is applied afterwards by
 * real transitions, never by the seed.
 */
export function deriveSeedSkills(input: SeedSkillsInput): SkillResult<SeedSkills> {
  const { caseOne, caseTwo } = input;
  const fork =
    caseOne.analysis.forks.find(
      (f) => f.id === caseOne.analysis.earliestMeaningfulForkId && f.eligibility.eligible,
    ) ?? caseOne.analysis.forks.find((f) => f.eligibility.eligible);
  if (!fork) {
    return skillFail(
      'extraction_refused',
      `${caseOne.reference} has no eligible decision fork to extract from.`,
    );
  }
  const rolloutCount = input.rolloutCount;
  const generated = generateCounterfactuals({
    analysis: caseOne.analysis,
    fork,
    strategies: ['balanced'],
    events: caseOne.events,
    resolution: caseOne.resolution,
    pack: caseOne.pack,
    config: caseOne.config,
    ctx: caseOne.ctx,
    ...(rolloutCount !== undefined ? { rolloutCount } : {}),
  });
  const scenario = generated.scenarios[0];
  if (!scenario) {
    return skillFail(
      'extraction_refused',
      'No counterfactual scenario could be generated for the fork.',
    );
  }
  const extraction: SkillExtractionInput = {
    analysis: caseOne.analysis,
    fork,
    scenarios: [scenario],
    events: caseOne.events,
    resolution: caseOne.resolution,
    pack: caseOne.pack,
    config: caseOne.config,
    ctx: caseOne.ctx,
    caseInfo: caseOne.caseInfo,
    caseReference: caseOne.reference,
    synthetic: caseOne.synthetic,
    // The seed has no reviewer to accept the scenario; the skill still starts as `discovered`.
    options: {
      requireAcceptedReview: false,
      ...(rolloutCount !== undefined ? { rolloutCount } : {}),
    },
  };
  const result = extractSkillCandidates(extraction);
  const draft = result.candidates[0];
  if (!draft) {
    return skillFail('extraction_refused', 'The seed case did not yield a skill candidate.', {
      refusals: result.refusals,
    });
  }
  const proposal = proposeMutations({
    aggregate: { skill: draft.skill, versions: [draft.version], validations: [], approvals: [] },
    source: caseTwo,
    actor: input.proposer,
    op: input.op,
  });
  const previewMutation =
    proposal.ok && proposal.value.status === 'proposed' ? proposal.value.proposal : null;
  return skillOk({
    draft,
    forkId: fork.id,
    scenarioId: scenario.id,
    mutationSource: caseTwo,
    previewMutation,
    refusals: result.refusals,
  });
}
