import type { ActionValueConfig, SkillDna, SkillVersion } from '@caseguard/schemas';
import type { DeterministicAnalysis } from '../engine/pipeline';
import { assertPreResolution, createTemporalView, type TemporalView } from '../engine/temporal';
import type { CompiledPack } from '../knowledge/compile';
import { planFromState, planNotices, summarizePlan, type GuidedPlan } from './plan';
import { knowledgeStateFromView, type KnowledgeState } from './state';

/** Anything that carries the case events; a full analysis qualifies, and only its events are read. */
export type AnalysisAsOf = Pick<DeterministicAnalysis, 'view'>;

/**
 * The strict temporal gate of every skill function: events up to and including `asOf`, never the
 * resolution, regardless of how much of the case the caller's analysis happens to contain.
 */
export function asOfView(analysisAsOf: AnalysisAsOf, asOf: string): TemporalView {
  const view = createTemporalView(analysisAsOf.view.events, asOf);
  assertPreResolution(view);
  return view;
}

export interface GuidedPlanInput {
  skill: SkillDna;
  version: SkillVersion;
  analysisAsOf: AnalysisAsOf;
  asOf: string;
  pack: CompiledPack;
  config: ActionValueConfig;
  ctx: { caseId: string };
}

/** Builds the plan from an already derived knowledge state (shared by matching and replays). */
export function guidedPlanFromState(args: {
  skill: SkillDna;
  version: SkillVersion;
  state: KnowledgeState;
  asOf: string;
  caseId: string;
  pack: CompiledPack;
  config: ActionValueConfig;
}): GuidedPlan {
  const { skill, version, state, asOf, caseId, pack, config } = args;
  const content = version.content;
  const core = planFromState({ content, pack, config, state });
  return {
    skillId: skill.id,
    versionId: version.id,
    skillName: content.name,
    skillVersion: version.version,
    lifecycle: skill.lifecycle,
    caseId,
    asOf,
    status: core.status,
    summary: summarizePlan(core),
    steps: core.steps,
    nextSteps: core.nextSteps,
    waitingOn: core.waitingOn,
    minimumEvidence: content.minimumEvidence.map((m) => ({
      requirementId: m.requirementId,
      label: m.label,
      satisfied: state.satisfied.has(m.requirementId),
    })),
    stopConditions: content.stopConditions,
    escalationConditions: content.escalationConditions,
    safetyConstraints: content.safetyConstraints,
    labels: { modelEstimate: true, estimated: true },
    notices: planNotices(asOf),
  };
}

/**
 * Ordered, guided next steps for a skill as of a moment: stages in the skill's order, alternatives in a
 * stage ranked by estimated action value, each with templates, expected outcomes and safety notes.
 */
export function buildGuidedPlan(input: GuidedPlanInput): GuidedPlan {
  const { skill, version, analysisAsOf, asOf, pack, config, ctx } = input;
  const view = asOfView(analysisAsOf, asOf);
  const { state } = knowledgeStateFromView(view, pack, ctx.caseId);
  return guidedPlanFromState({ skill, version, state, asOf, caseId: ctx.caseId, pack, config });
}
