import {
  buildGuidedPlan,
  checkConformance,
  compareIso,
  createTemporalView,
  estimateSkillImpact,
  matchSkills,
  type MatchableSkill,
  type SkillConformanceReport,
  type SkillImpactEstimate,
  type SkillImpactPrecedent,
  type SkillUsageRecord,
} from '@caseguard/domain';
import type { CaseReplay } from '../counterfactuals/replay';

export interface SkillUsage {
  readonly record: SkillUsageRecord;
  /** The moment on the case timeline from which the skill's plan and the recorded path are compared. */
  readonly anchorAt: string;
  readonly conformance: SkillConformanceReport;
  readonly impact: SkillImpactEstimate;
}

/**
 * What an application is compared with besides the simulated baseline: the recorded path of the case
 * the skill came from, or why there is none (the application is on that case, or it is not available).
 */
export type PrecedentOutcome =
  | { readonly precedent: SkillImpactPrecedent }
  | {
      readonly precedent: null;
      readonly unavailable: NonNullable<SkillUsageRecord['precedentUnavailable']>;
    };

/** The precedent fields of a usage record: only the figures an aggregate needs, and the reason when absent. */
function precedentFields(
  outcome: PrecedentOutcome | undefined,
): Pick<SkillUsageRecord, 'precedent' | 'precedentUnavailable'> {
  if (outcome === undefined) return {};
  if (outcome.precedent === null) {
    return { precedent: null, precedentUnavailable: outcome.unavailable };
  }
  const { reference, timeToDiagnosisMinutes, tokenEstimate, evidenceCompleteness } =
    outcome.precedent;
  return { precedent: { reference, timeToDiagnosisMinutes, tokenEstimate, evidenceCompleteness } };
}

/** Cases with more events than this are scanned only from their start; the anchor then falls back to the end. */
const MAX_SCANNED_EVENTS = 400;

/** Timestamp of the last event of a case (its open time when it has none). */
export function lastEventAtOf(replay: Pick<CaseReplay, 'inputs'>): string {
  const { events, caseRecord } = replay.inputs;
  return events[events.length - 1]?.timestamp ?? caseRecord.openedAt;
}

/**
 * The first moment at which the skill applies to the case (or partially applies), using only the
 * evidence known at that moment. It anchors the comparison for effectiveness: "from when the skill
 * could have guided this case". Null when it never applies.
 */
export function firstApplicableAt(
  replay: Pick<CaseReplay, 'inputs' | 'engineCtx'>,
  entry: MatchableSkill,
): string | null {
  const { inputs, engineCtx } = replay;
  const caseInfo = { workload: inputs.caseRecord.workload, product: inputs.caseRecord.product };
  const instants = [...new Set(inputs.events.map((event) => event.timestamp))]
    .sort(compareIso)
    .slice(0, MAX_SCANNED_EVENTS);
  for (const instant of instants) {
    const set = matchSkills({
      skills: [entry],
      analysisAsOf: { view: createTemporalView(inputs.events, instant) },
      asOf: instant,
      pack: inputs.pack,
      config: inputs.actionConfig,
      ctx: engineCtx,
      caseInfo,
    });
    if (set.matches[0] !== undefined && set.matches[0].applicability !== 'not_applicable') {
      return instant;
    }
  }
  return null;
}

/**
 * What one application of a skill to a finished or running case contributes to its effectiveness:
 * the recorded path (measured from the case record) against the estimated "without the skill"
 * baseline, and how closely the recorded steps followed the skill. The comparison is an estimate from
 * simulated rollouts with no control group; it is labelled so wherever it is shown.
 *
 * With `precedent` the record also carries the recorded path of the case the skill came from, so an
 * aggregate can compare two recorded paths (different cases, each from its own decision point) next to
 * the simulated baseline. Without it the record is exactly what it was before.
 */
export function buildSkillUsage(args: {
  readonly replay: CaseReplay;
  readonly entry: MatchableSkill;
  readonly applied: boolean;
  readonly precedent?: PrecedentOutcome;
}): SkillUsage {
  const { replay, entry, applied } = args;
  const { inputs, analysis, engineCtx } = replay;
  const { skill, version } = entry;
  const lastEventAt = lastEventAtOf(replay);
  const anchorAt = firstApplicableAt(replay, entry) ?? lastEventAt;

  const plan = buildGuidedPlan({
    skill,
    version,
    analysisAsOf: analysis,
    asOf: anchorAt,
    pack: inputs.pack,
    config: inputs.actionConfig,
    ctx: engineCtx,
  });
  const conformance = checkConformance({
    version,
    analysis,
    pack: inputs.pack,
    config: inputs.actionConfig,
    caseId: inputs.caseRecord.id,
    appliedAt: anchorAt,
    throughAt: lastEventAt,
  });
  const impact = estimateSkillImpact({
    plan,
    version,
    analysis,
    pack: inputs.pack,
    config: inputs.actionConfig,
    ctx: engineCtx,
    synthetic: inputs.caseRecord.synthetic,
    conformance,
  });

  const recorded = impact.recorded;
  const { metrics } = impact.baseline;
  return {
    anchorAt,
    conformance,
    impact,
    record: {
      skillId: skill.id,
      versionId: version.id,
      caseId: inputs.caseRecord.id,
      synthetic: inputs.caseRecord.synthetic,
      matched: true,
      applied,
      suggestionsOffered: conformance.stagesTotal,
      suggestionsAccepted: conformance.stagesFollowed,
      timeToDiagnosisMinutes: recorded?.reachedDiagnosis ? recorded.timeToDiagnosisMinutes : null,
      baselineTimeToDiagnosisMinutes: metrics.timeToDiagnosisMinutes.mid,
      tokenEstimate: recorded?.tokenEstimate ?? null,
      baselineTokenEstimate: metrics.tokenEstimate.mid,
      evidenceCompleteness: recorded?.evidenceCompleteness ?? null,
      baselineEvidenceCompleteness: metrics.evidenceCompleteness.mid,
      conformanceScore: conformance.score,
      ...precedentFields(args.precedent),
    },
  };
}

/** A usage record for a match that was offered but not applied: it counts as matched and nothing more. */
export function matchedOnlyRecord(args: {
  readonly skillId: string;
  readonly versionId: string;
  readonly caseId: string;
  readonly synthetic: boolean;
}): SkillUsageRecord {
  return {
    ...args,
    matched: true,
    applied: false,
    suggestionsOffered: 0,
    suggestionsAccepted: 0,
    timeToDiagnosisMinutes: null,
    baselineTimeToDiagnosisMinutes: null,
    tokenEstimate: null,
    baselineTokenEstimate: null,
    evidenceCompleteness: null,
    baselineEvidenceCompleteness: null,
    conformanceScore: null,
  };
}
