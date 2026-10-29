import type {
  ActionKind,
  ActionValueConfig,
  CaseEvent,
  Claim,
  DecisionFork,
  DiagnosticAction,
  EffortLevel,
  EvidenceLink,
  Priority,
  WarningCategory,
} from '@caseguard/schemas';
import type { DecisionRanking } from '../engine/actions';
import type { Belief } from '../engine/belief';
import type { AnchorInfo } from '../engine/claims';
import type { RequirementState } from '../engine/requirements';
import type { ActionEvaluation } from '../engine/action-value';
import type { CompiledPack } from '../knowledge/compile';

/** Thresholds of the live rules. Plain numbers, overridable per call. */
export interface LiveWarningOptions {
  /** A customer message that expects an answer has waited this long without an engineer-facing reply. */
  replyWaitHours: number;
  /** The same wait, escalated to a higher priority. */
  replyWaitCriticalHours: number;
  /** Customer effort score (0-1) from which a request counts as heavy for the expectation-setting rule. */
  heavyEffortScore: number;
  /** A scoping item must have been missing this long (and never requested) before it is flagged. */
  scopingGraceMinutes: number;
}

export const DEFAULT_LIVE_WARNING_OPTIONS: LiveWarningOptions = {
  replyWaitHours: 4,
  replyWaitCriticalHours: 24,
  heavyEffortScore: 0.8,
  scopingGraceMinutes: 120,
};

/** The safer next step a warning points to, taken from the knowledge pack (all values are estimates). */
export interface SuggestedStep {
  actionKey: string;
  label: string;
  kind: ActionKind;
  timeMinutes: number;
  customerEffort: EffortLevel;
  operationalRisk: number;
  tokenEstimate: number;
}

/** A condition that holds at one checkpoint, before dedupe and lifecycle are applied. */
export interface WarningCandidate {
  ruleId: string;
  /** Stable identity of the situation (an event, a hypothesis, a tier); with the rule it forms the dedupe key. */
  subject: string;
  dedupeKey: string;
  category: WarningCategory;
  priority: Priority;
  title: string;
  /** Plain-language rationale for the engineer. */
  message: string;
  suggestedAction: string;
  suggestion: SuggestedStep | null;
  evidence: EvidenceLink[];
  /** When the condition first held (the triggering event, or the instant a waiting threshold passed). */
  raisedAt: string;
  /** "state" warnings clear when the condition stops holding; "nudge" warnings clear at the next engineer step. */
  kind: 'state' | 'nudge';
  /** Index of the triggering event for nudges (null for state warnings). */
  triggerIndex: number | null;
  /** Dedupe keys of lower tiers this candidate makes obsolete. */
  supersedes: string[];
}

/**
 * Everything the rules may read: strictly the information known at one instant. It is built by
 * restricting an analysis to events at or before `index`, so no rule can see a later event.
 */
export interface Checkpoint {
  /** Index of the last visible event (-1 when no event is visible). */
  index: number;
  /** Timestamp of the last visible event. */
  at: string;
  /** Evaluation instant, never earlier than `at`. */
  now: string;
  events: readonly CaseEvent[];
  pack: CompiledPack;
  config: ActionValueConfig;
  options: LiveWarningOptions;
  actions: readonly DiagnosticAction[];
  actionByEvent: ReadonlyMap<string, DiagnosticAction>;
  claims: readonly Claim[];
  anchors: readonly AnchorInfo[];
  forks: readonly DecisionFork[];
  belief: Belief;
  indexOf: (eventId: string) => number;
  requirement: (id: string) => RequirementState | undefined;
  satisfied: (id: string) => boolean;
  /** Whether the requirement was already satisfied strictly before the event at `index`. */
  satisfiedBefore: (id: string, index: number) => boolean;
  hypothesisName: (key: string) => string;
  /** Resolves a hypothesis reference (record id or pack key) to the pack key. */
  hypothesisKey: (reference: string) => string;
  /** Label of an evidence item observed at or before this instant. */
  evidenceLabel: (evidenceId: string) => string | undefined;
  decision: (eventId: string) => DecisionRanking | undefined;
  /** Safe candidate steps ranked for the evidence on record now (cached per checkpoint). */
  rankNext: () => readonly ActionEvaluation[];
  /** Whether a closure statement (resolution note, closing status change) is visible, and where. */
  closureIndex: number;
}

export type WarningRule = (cp: Checkpoint) => WarningCandidate[];

export interface WarningDismissal {
  /** The warning's dedupe key (its `fingerprint`). */
  dedupeKey: string;
  by: string;
  at: string;
  reason: string;
}

export interface WarningTransition {
  at: string;
  dedupeKey: string;
  warningId: string;
  kind: 'raised' | 'resolved' | 'dismissed' | 'suppressed' | 'superseded';
  detail: string;
}
