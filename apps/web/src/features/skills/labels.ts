import {
  SKILL_LIFECYCLE,
  SKILL_LIFECYCLE_LABELS,
  type SkillApproval,
  type SkillLifecycle,
  type SkillValidation,
  type SkillVersion,
} from '@caseguard/schemas';
import type { BadgeStatus } from '@caseguard/ui';

export interface Labelled {
  label: string;
  status: BadgeStatus;
}

/** Lifecycle badges: text first, with a pattern and icon from the status grammar; colour never carries it alone. */
export const LIFECYCLE_BADGES: Record<SkillLifecycle, Labelled> = {
  discovered: { label: SKILL_LIFECYCLE_LABELS.discovered, status: 'missing' },
  draft: { label: SKILL_LIFECYCLE_LABELS.draft, status: 'neutral' },
  simulation_tested: { label: SKILL_LIFECYCLE_LABELS.simulation_tested, status: 'uncertain' },
  expert_reviewed: { label: SKILL_LIFECYCLE_LABELS.expert_reviewed, status: 'uncertain' },
  pilot: { label: SKILL_LIFECYCLE_LABELS.pilot, status: 'uncertain' },
  validated: { label: SKILL_LIFECYCLE_LABELS.validated, status: 'productive' },
  published: { label: SKILL_LIFECYCLE_LABELS.published, status: 'productive' },
  deprecated: { label: SKILL_LIFECYCLE_LABELS.deprecated, status: 'neutral' },
  retired: { label: SKILL_LIFECYCLE_LABELS.retired, status: 'missing' },
};

/** The ordered path a skill walks to publication. Deprecated and retired are where it ends up when withdrawn. */
export const LIFECYCLE_PATH: readonly SkillLifecycle[] = SKILL_LIFECYCLE.filter(
  (state) => state !== 'deprecated' && state !== 'retired',
);
export const WITHDRAWN_STATES: readonly SkillLifecycle[] = ['deprecated', 'retired'];

/** What each lifecycle state means, in the words used by the help popovers and the stepper. */
export const LIFECYCLE_MEANING: Record<SkillLifecycle, string> = {
  discovered:
    'Extracted from an accepted counterfactual path. Nothing has been checked by a person yet.',
  draft: 'Adopted for review by a person other than the one who extracted it.',
  simulation_tested: 'A full simulation test replayed the skill on its source case and passed.',
  expert_reviewed: 'A reviewer other than the creator checked the skill against its source case.',
  pilot: 'Approved to be tried on a related case, by someone other than the creator.',
  validated: 'Passed the full simulation test and the regression suite.',
  published:
    'Live for matching. Publication is always a human decision, by someone other than the creator and the pilot approver.',
  deprecated: 'Withdrawn from new matching; existing applications are kept.',
  retired: 'No longer used. Kept for history.',
};

export const VALIDATION_KIND_LABELS: Record<SkillValidation['kind'], string> = {
  simulation_test: 'Simulation test',
  expert_review: 'Expert review',
  pilot_application: 'Pilot application',
  regression: 'Regression suite',
};

export const VALIDATION_OUTCOMES: Record<SkillValidation['outcome'], Labelled> = {
  passed: { label: 'Passed', status: 'productive' },
  failed: { label: 'Failed', status: 'unsupported' },
  inconclusive: { label: 'Inconclusive', status: 'uncertain' },
};

export const VERSION_STATES: Record<SkillVersion['state'], Labelled> = {
  active: { label: 'Active', status: 'productive' },
  proposed: { label: 'Proposed', status: 'uncertain' },
  superseded: { label: 'Superseded', status: 'neutral' },
  rejected: { label: 'Rejected', status: 'unsupported' },
};

export const CHANGE_TYPE_LABELS: Record<SkillVersion['changeType'], string> = {
  initial: 'First version',
  mutation: 'Proposed change',
  rollback: 'Rollback',
  edit: 'Edit',
};

export type ApprovalPresentation = Labelled & { sentence: (actor: string) => string };

/**
 * How one stored approval row reads. Withdrawing a skill (to Deprecated or Retired) is stored as a `rejected` decision
 * (a rejection of the skill's continued use, the one decision the creator may record), so it is shown as "Withdrawn", never
 * as "Rejected". A `rejected` decision on a proposed version is a real rejection.
 */
export function presentApproval(
  approval: Pick<SkillApproval, 'decision' | 'toState' | 'fromState'>,
): ApprovalPresentation {
  const to = SKILL_LIFECYCLE_LABELS[approval.toState];
  const sameState = approval.fromState === approval.toState;
  if (approval.decision === 'rejected' && WITHDRAWN_STATES.includes(approval.toState)) {
    return {
      label: `Withdrawn (${to.toLowerCase()})`,
      status: 'neutral',
      sentence: (actor) => `Withdrawn (${to.toLowerCase()}) by ${actor}`,
    };
  }
  if (approval.decision === 'rejected') {
    return {
      label: sameState ? 'Rejected a proposed version' : 'Rejected',
      status: 'unsupported',
      sentence: (actor) =>
        sameState ? `A proposed version was rejected by ${actor}` : `Rejected by ${actor}`,
    };
  }
  if (approval.decision === 'changes_requested') {
    return {
      label: `Sent back to ${to}`,
      status: 'uncertain',
      sentence: (actor) => `Sent back to ${to} by ${actor} (changes requested)`,
    };
  }
  if (sameState) {
    return {
      label: 'Approved a proposed version',
      status: 'productive',
      sentence: (actor) => `A proposed version was approved by ${actor}`,
    };
  }
  if (approval.fromState === 'expert_reviewed' && approval.toState === 'simulation_tested') {
    return {
      label: 'Approved a proposed version',
      status: 'productive',
      sentence: (actor) =>
        `A proposed version was approved by ${actor}; the skill went back to ${to} so the new content is reviewed again`,
    };
  }
  return {
    label: `Approved: ${to}`,
    status: 'productive',
    sentence: (actor) => `Moved to ${to} by ${actor}`,
  };
}

/** True for a skill that can no longer be matched or applied. */
export function isWithdrawn(lifecycle: SkillLifecycle): boolean {
  return WITHDRAWN_STATES.includes(lifecycle);
}
