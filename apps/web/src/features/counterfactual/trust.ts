import {
  COUNTERFACTUAL_BASIS_DESCRIPTIONS,
  COUNTERFACTUAL_BASIS_LABELS,
  FEASIBILITY_LABELS,
  type CounterfactualBasis,
  type CounterfactualQuality,
  type FeasibilityLevel,
  type ScenarioSkillApplicability,
} from '@caseguard/schemas';
import type { BadgeStatus } from '@caseguard/ui';

/** How far to trust a simulated path, in the words the product uses (engine 2026.4.0 and later write it). */

const BASIS_BADGE: Record<CounterfactualBasis, BadgeStatus> = {
  measured: 'productive',
  deterministic_estimate: 'neutral',
  model_estimate: 'uncertain',
  illustrative: 'uncertain',
};

const FEASIBILITY_BADGE: Record<FeasibilityLevel, BadgeStatus> = {
  feasible: 'productive',
  feasible_with_conditions: 'uncertain',
  not_feasible: 'unsupported',
};

const SKILL_LABELS: Record<ScenarioSkillApplicability['status'], string> = {
  applies: 'A governed skill already applied at that moment',
  partially_applies: 'A governed skill partly applied at that moment',
  no_matching_skill: 'No governed skill applied at that moment',
  not_assessed: 'Skills were not checked against this path',
};

export interface TrustView {
  basisLabel: string;
  basisBadge: BadgeStatus;
  basisMeaning: string;
  feasibilityLabel: string;
  feasibilityBadge: BadgeStatus;
  summary: string;
  /** What the product may say about a saving: a range or nothing at all. */
  claimText: string;
  parts: { what: string; basisLabel: string; note: string }[];
  feasibilityReasons: string[];
  constraints: string[];
  validation: string[];
  skill: {
    label: string;
    note: string;
    skills: { name: string; coverageText: string; recommendsFirstStep: boolean }[];
  };
}

/** The view of a scenario's quality block, or null for a scenario stored before the engine wrote one. */
export function describeTrust(quality: CounterfactualQuality | undefined): TrustView | null {
  if (quality === undefined) return null;
  const { basis, feasibility, skillApplicability } = quality;
  return {
    basisLabel: COUNTERFACTUAL_BASIS_LABELS[basis.scenario],
    basisBadge: BASIS_BADGE[basis.scenario],
    basisMeaning: COUNTERFACTUAL_BASIS_DESCRIPTIONS[basis.scenario],
    feasibilityLabel: FEASIBILITY_LABELS[feasibility.level],
    feasibilityBadge: FEASIBILITY_BADGE[feasibility.level],
    summary: basis.summary,
    claimText:
      quality.timeSavedClaim === 'estimated_range'
        ? 'Times are shown as ranges. No exact saving is claimed.'
        : 'No saving is claimed for this path.',
    parts: basis.parts.map((part) => ({
      what: part.what,
      basisLabel: COUNTERFACTUAL_BASIS_LABELS[part.basis],
      note: part.note,
    })),
    feasibilityReasons: feasibility.reasons,
    constraints: quality.constraints,
    validation: quality.validation,
    skill: {
      label: SKILL_LABELS[skillApplicability.status],
      note: skillApplicability.note,
      skills: skillApplicability.skills.map((skill) => ({
        name: skill.name,
        coverageText: `${Math.round(skill.triggerCoverage * 100)}% of its triggers held`,
        recommendsFirstStep: skill.recommendsFirstStep,
      })),
    },
  };
}
