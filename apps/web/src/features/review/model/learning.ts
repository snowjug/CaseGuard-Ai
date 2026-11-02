import {
  SKILL_LIFECYCLE_LABELS,
  type EvidenceLink,
  type SkillLifecycle,
  type SkillMatch,
  type SkillOverlay,
} from '@caseguard/schemas';
import { formatNumber, formatProbability, type BadgeStatus } from '@caseguard/ui';
import { evidenceLinks, uniqueLinks } from './links';
import { describeRange, plural } from './words';

export const APPLICABILITY_WORDS: Record<
  SkillMatch['applicability'],
  { label: string; badge: BadgeStatus }
> = {
  applies: { label: 'Applies', badge: 'productive' },
  partial: { label: 'Partly applies', badge: 'uncertain' },
  not_applicable: { label: 'Does not apply', badge: 'missing' },
};

const STEP_WORDS: Record<SkillMatch['recommendedSteps'][number]['status'], string> = {
  recommended_next: 'Recommended next',
  done: 'Done',
  skipped: 'Skipped',
  pending: 'Not reached',
};

/** The engine marks a condition it learned from the source case with knowledge of that case's cause. */
const HINDSIGHT_MARK = /\(hindsight-informed\)/i;

export interface LearningMatch {
  matchId: string;
  skillId: string;
  skillName: string;
  version: string;
  lifecycle: SkillLifecycle;
  lifecycleLabel: string;
  score: number;
  scoreText: string;
  applicability: SkillMatch['applicability'];
  applicabilityLabel: string;
  applicabilityBadge: BadgeStatus;
  applied: boolean;
  appliedAt: string | null;
  appliedBy: string | null;
  conformanceText: string | null;
  rationale: string;
  met: { id: string; description: string; links: EvidenceLink[]; hindsight: boolean }[];
  unmet: { id: string; description: string; hindsight: boolean }[];
  exclusions: string[];
  steps: { id: string; title: string; instruction: string; statusLabel: string }[];
  anyHindsight: boolean;
  /** The evidence that made the skill match, for the chips. */
  links: EvidenceLink[];
  asOf: string;
}

export interface LearningModel {
  /** The skills that apply or partly apply, best fit first. */
  matches: LearningMatch[];
  /** How many matched skills were left out because they do not apply to this case. */
  notApplicable: number;
}

function describeMatch(match: SkillMatch): LearningMatch {
  const applicability = APPLICABILITY_WORDS[match.applicability];
  const met = match.matchedTriggers.map((trigger) => ({
    id: trigger.id,
    description: trigger.description,
    links: evidenceLinks(trigger.evidenceIds),
    hindsight: HINDSIGHT_MARK.test(trigger.description),
  }));
  const unmet = match.unmatchedTriggers.map((trigger) => ({
    id: trigger.id,
    description: trigger.description,
    hindsight: HINDSIGHT_MARK.test(trigger.description),
  }));
  return {
    matchId: match.id,
    skillId: match.skillId,
    skillName: match.skillName,
    version: match.skillVersion,
    lifecycle: match.lifecycle,
    lifecycleLabel: SKILL_LIFECYCLE_LABELS[match.lifecycle],
    score: match.score,
    scoreText: formatProbability(match.score, 0),
    applicability: match.applicability,
    applicabilityLabel: applicability.label,
    applicabilityBadge: applicability.badge,
    applied: match.applied,
    appliedAt: match.appliedAt,
    appliedBy: match.appliedBy,
    conformanceText: match.conformance
      ? `${match.conformance.stepsFollowed} of ${plural(match.conformance.stepsTotal, 'step')} followed`
      : null,
    rationale: match.rationale,
    met,
    unmet,
    exclusions: match.exclusionsHit.map((exclusion) => exclusion.description),
    steps: match.recommendedSteps.map((step) => ({
      id: step.stepId,
      title: step.title,
      instruction: step.instruction,
      statusLabel: STEP_WORDS[step.status],
    })),
    anyHindsight: [...met, ...unmet].some((trigger) => trigger.hindsight),
    links: uniqueLinks(met.flatMap((trigger) => trigger.links)),
    asOf: match.asOf,
  };
}

/** The skills that resemble the case: those that apply or partly apply, best fit first. */
export function deriveLearning(matches: readonly SkillMatch[]): LearningModel {
  const order = { applies: 0, partial: 1, not_applicable: 2 } as const;
  const usable = matches
    .filter((match) => match.applicability !== 'not_applicable')
    .sort(
      (a, b) =>
        order[a.applicability] - order[b.applicability] ||
        b.score - a.score ||
        a.skillName.localeCompare(b.skillName),
    );
  return {
    matches: usable.map(describeMatch),
    notApplicable: matches.length - usable.length,
  };
}

// ------------------------------------------------------------------------------------------------ overlay

export interface OverlayRowView {
  key: string;
  label: string;
  /** The API's own figures, formatted and never combined: the screen does no arithmetic of its own. */
  recorded: string | null;
  withSkill: string | null;
  saved: string | null;
  basis: string;
}

/** What the skill saved on the case it came from, for a case that has nothing recorded to set it against. */
export interface SavingOnlyView {
  rows: { key: string; label: string; saved: string; basis: string }[];
  /** The one sentence that explains every row when they all share it (it is then said once); otherwise `null`. */
  sharedBasis: string | null;
}

export interface OverlayView {
  matchId: string;
  decision: { forkId: string; eventId: string; at: string; title: string; summary: string } | null;
  recorded: { label: string | null; followed: boolean; note: string };
  steps: { id: string; title: string; instruction: string; statusLabel: string }[];
  cheaper: { instead: string; use: string; rationale: string; minutesSaved: string | null } | null;
  rows: OverlayRowView[];
  /** True when no row could compare the recorded path with the skill (the API left `withSkill` empty everywhere). */
  nothingToCompare: boolean;
  /**
   * When the case has no recorded figure and no with-skill figure at all, only the rows that carry the skill's own
   * saving (so the screen does not show a table of empty cells); otherwise `null`.
   */
  savingOnly: SavingOnlyView | null;
  assumptions: string[];
  limitations: string[];
  links: EvidenceLink[];
}

const num = (value: number): string => formatNumber(value, { maximumFractionDigits: 2 });

/** The figures of a row exactly as the API gave them, with the unit: `240 min (120 min to 480 min)`. */
export function overlayFigure(
  range: { low: number; mid: number; high: number } | null,
  unit: 'minutes' | 'tokens',
): string | null {
  if (!range) return null;
  const word = unit === 'minutes' ? 'min' : 'tokens';
  return describeRange(range, (value) => `${num(value)} ${word}`);
}

/** What the skill would have changed, from the server's own comparison. Nothing here is computed by the screen. */
export function describeOverlay(overlay: SkillOverlay): OverlayView {
  const rows = overlay.comparison.map((row) => ({
    key: row.key,
    label: row.label,
    recorded: overlayFigure(row.recorded, row.unit),
    withSkill: overlayFigure(row.withSkill, row.unit),
    saved: overlayFigure(row.saved, row.unit),
    basis: row.basis,
  }));
  const cheaper = overlay.withSkill.cheaperAlternative;
  const savings = rows.flatMap((row) =>
    row.saved === null
      ? []
      : [{ key: row.key, label: row.label, saved: row.saved, basis: row.basis }],
  );
  const nothingRecorded = rows.every((row) => row.recorded === null && row.withSkill === null);
  const firstBasis = savings[0]?.basis;
  const sharedBasis =
    firstBasis !== undefined && savings.every((row) => row.basis === firstBasis)
      ? firstBasis
      : null;
  return {
    matchId: overlay.matchId,
    decision: overlay.decisionPoint
      ? {
          forkId: overlay.decisionPoint.forkId,
          eventId: overlay.decisionPoint.eventId,
          at: overlay.decisionPoint.at,
          title: overlay.decisionPoint.title,
          summary: overlay.decisionPoint.summary,
        }
      : null,
    recorded: {
      label: overlay.recorded.actionLabel,
      followed: overlay.recorded.followedRecommendedStep,
      note: overlay.recorded.note,
    },
    steps: overlay.withSkill.steps.map((step) => ({
      id: step.stepId,
      title: step.title,
      instruction: step.instruction,
      statusLabel: STEP_WORDS[step.status],
    })),
    cheaper: cheaper
      ? {
          instead: cheaper.insteadOfLabel,
          use: cheaper.useLabel,
          rationale: cheaper.rationale,
          minutesSaved:
            cheaper.estimatedCustomerMinutesSaved === null
              ? null
              : `${num(cheaper.estimatedCustomerMinutesSaved)} min of customer time (estimate)`,
        }
      : null,
    rows,
    nothingToCompare: rows.every((row) => row.withSkill === null),
    savingOnly: nothingRecorded && savings.length > 0 ? { rows: savings, sharedBasis } : null,
    assumptions: overlay.assumptions,
    limitations: overlay.limitations,
    links: uniqueLinks(overlay.evidence),
  };
}
