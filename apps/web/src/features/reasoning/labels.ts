import type {
  ActionExecutor,
  EffortLevel,
  HypothesisStatus,
  Level,
  ReviewState,
  Strength,
} from '@caseguard/schemas';
import type { BadgeStatus } from '@caseguard/ui';

/**
 * Display labels shared by the Hypothesis Arena and the Counterfactual Lab. Every status pairs a label with a
 * `BadgeStatus`, which carries the icon and pattern, so no state is ever shown by colour alone.
 */

export interface StatusLabel {
  label: string;
  status: BadgeStatus;
}

/** Mirrors the graph: leading and confirmed read as productive, demoted and ruled out as unsupported. */
export const HYPOTHESIS_STATUS_BADGES: Record<HypothesisStatus, StatusLabel> = {
  leading: { label: 'Leading', status: 'productive' },
  confirmed: { label: 'Confirmed', status: 'productive' },
  active: { label: 'Still possible', status: 'uncertain' },
  demoted: { label: 'Demoted', status: 'uncertain' },
  ruled_out: { label: 'Ruled out', status: 'unsupported' },
};

export const HYPOTHESIS_STATUS_MEANING: Record<HypothesisStatus, string> = {
  leading: 'The model currently rates this explanation highest.',
  confirmed:
    'Confidence passed the diagnosis threshold and the confirmation evidence is on record.',
  active: 'Still a live candidate: the evidence has not ruled it out.',
  demoted: 'Evidence has made it less likely than before, but it is not ruled out.',
  ruled_out: 'Evidence on record makes it very unlikely.',
};

export const REVIEW_STATE_BADGES: Record<ReviewState, StatusLabel> = {
  pending: { label: 'Awaiting review', status: 'uncertain' },
  confirmed: { label: 'Accepted', status: 'productive' },
  corrected: { label: 'Accepted with a correction', status: 'productive' },
  rejected: { label: 'Rejected', status: 'unsupported' },
};

/** True when a reviewer accepted the scenario: the only state a skill may be extracted from. */
export const isAcceptedState = (state: ReviewState): boolean =>
  state === 'confirmed' || state === 'corrected';

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'No customer effort',
  low: 'Low customer effort',
  medium: 'Medium customer effort',
  high: 'High customer effort',
  very_high: 'Very high customer effort',
};

export const EFFORT_SHORT_LABELS: Record<EffortLevel, string> = {
  none: 'None',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  very_high: 'Very high',
};

/** Who carries out a simulated step. */
export const EXECUTOR_LABELS: Record<ActionExecutor, string> = {
  engineer: 'Support engineer',
  customer_admin: 'Customer admin',
  customer_network_admin: 'Customer network admin',
  customer_end_user: 'Customer end user',
  system: 'System (automated)',
};

export const LEVEL_LABELS: Record<Level, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const STRENGTH_LABELS: Record<Strength, string> = {
  strong: 'Strong evidence',
  moderate: 'Moderate evidence',
  weak: 'Weak evidence',
};

/** Operational risk: shown as the model's own 0 to 1 score. The UI never invents bands the API does not define. */
export function formatRiskScore(risk: number): string {
  return `${risk.toFixed(2)} of 1`;
}

export const SEVERITY_BADGES: Record<Level, StatusLabel> = {
  high: { label: 'High severity', status: 'unsupported' },
  medium: { label: 'Medium severity', status: 'uncertain' },
  low: { label: 'Low severity', status: 'neutral' },
};
