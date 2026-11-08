import {
  SKILL_LIFECYCLE,
  type SkillApproval,
  type SkillLifecycle,
  type SkillValidation,
  type SkillVersion,
} from '@caseguard/schemas';
import type { BadgeStatus, ToneName } from '@caseguard/ui';
import {
  ArchiveIcon,
  BanIcon,
  CircleCheckIcon,
  FlaskConicalIcon,
  PencilLineIcon,
  RocketIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UserCheckIcon,
  type LucideIcon,
} from 'lucide-react';

export interface Labelled {
  label: string;
  status: BadgeStatus;
}

/**
 * The status of a skill in plain words (the schema's own labels say "Simulation Tested" and "Expert Reviewed"). Every
 * visible mention of a status in these screens reads from here, so one stage never has two names.
 */
export const LIFECYCLE_LABELS: Record<SkillLifecycle, string> = {
  discovered: 'Discovered',
  draft: 'Draft',
  simulation_tested: 'Tested',
  expert_reviewed: 'Reviewed',
  pilot: 'Pilot',
  validated: 'Validated',
  published: 'Published',
  deprecated: 'Deprecated',
  retired: 'Retired',
};

export interface LifecycleLook {
  label: string;
  tone: ToneName;
  icon: LucideIcon;
  /** Dashed outline: a stage that is not established yet or no longer in use. */
  dashed?: boolean;
}

/**
 * How each status looks: the accent while a skill is being checked, green once it is validated or live, neutral for the
 * start and for withdrawn skills. Colour is never alone: every status has an icon and its word.
 */
export const LIFECYCLE_BADGES: Record<SkillLifecycle, LifecycleLook> = {
  discovered: {
    label: LIFECYCLE_LABELS.discovered,
    tone: 'neutral',
    icon: SparklesIcon,
    dashed: true,
  },
  draft: { label: LIFECYCLE_LABELS.draft, tone: 'neutral', icon: PencilLineIcon },
  simulation_tested: {
    label: LIFECYCLE_LABELS.simulation_tested,
    tone: 'brand',
    icon: FlaskConicalIcon,
  },
  expert_reviewed: { label: LIFECYCLE_LABELS.expert_reviewed, tone: 'brand', icon: UserCheckIcon },
  pilot: { label: LIFECYCLE_LABELS.pilot, tone: 'brand', icon: RocketIcon },
  validated: { label: LIFECYCLE_LABELS.validated, tone: 'productive', icon: ShieldCheckIcon },
  published: { label: LIFECYCLE_LABELS.published, tone: 'productive', icon: CircleCheckIcon },
  deprecated: { label: LIFECYCLE_LABELS.deprecated, tone: 'neutral', icon: ArchiveIcon },
  retired: { label: LIFECYCLE_LABELS.retired, tone: 'neutral', icon: BanIcon, dashed: true },
};

/** The ordered path a skill walks to publication. Deprecated and retired are where it ends up when withdrawn. */
export const LIFECYCLE_PATH: readonly SkillLifecycle[] = SKILL_LIFECYCLE.filter(
  (state) => state !== 'deprecated' && state !== 'retired',
);
export const WITHDRAWN_STATES: readonly SkillLifecycle[] = ['deprecated', 'retired'];

/** The stages in order, as one phrase for tooltips: "Discovered, draft, tested, reviewed, pilot, validated, published". */
export const LIFECYCLE_STAGES_TEXT = LIFECYCLE_PATH.map((state, index) =>
  index === 0 ? LIFECYCLE_LABELS[state] : LIFECYCLE_LABELS[state].toLowerCase(),
).join(', ');

/** The wording of the badge on a condition that was learned with knowledge of the source case's recorded cause. */
export const HINDSIGHT_LABEL = 'Learned with hindsight';

/** What each lifecycle state means, in the words used by the help popovers and the stepper. */
export const LIFECYCLE_MEANING: Record<SkillLifecycle, string> = {
  discovered: 'Found in a safer path that a reviewer accepted. Nobody has checked it yet.',
  draft: 'Taken up for review by someone other than the person who found it.',
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
  const to = LIFECYCLE_LABELS[approval.toState];
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
        `A proposed version was approved by ${actor}; the skill went back to the ${to} step so the new content is reviewed again`,
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
