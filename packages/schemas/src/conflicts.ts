import { z } from 'zod';
import { IdSchema, IsoTimestampSchema, SourceRefSchema } from './common';
import { LevelSchema, ParticipantRoleSchema } from './enums';

/**
 * Contracts shared by the deterministic reading of a case (negation, temporal reasoning, contradictions), the
 * evaluation set and the optional model-assisted layer (wave 2). They only name things; the rules that fill them live in
 * `packages/domain`.
 */

// ---------------------------------------------------------------- modality

/**
 * How a statement stands to the fact it mentions. A detector that finds the words of a signal in a sentence still has
 * to know whether the sentence states the fact. Only `asserted` states it; every other value says why it does not.
 */
export const STATEMENT_MODALITIES = [
  /** "The engineer checked the logs." The author states it as fact. */
  'asserted',
  /** "No log review was performed.", "The logs show no evidence of a token issue." */
  'negated',
  /** "It might be DNS.", "Possibly the proxy." A guess or hypothesis, not an observation. */
  'speculative',
  /** "I will check the logs.", "Next step: ask for a HAR capture." Intended, not done. */
  'future_intent',
  /** "If the logs had been checked...", "Unless the cache is cleared..." A condition, not a fact. */
  'conditional',
  /** "The customer said the logs were checked." Reported on someone else's authority. */
  'attributed',
  /** "Please send a HAR capture." A request: the act of asking is real, what is asked for is not yet done. */
  'requested',
  /** "Correction: the proxy was not changed." Replaces an earlier statement. */
  'corrected',
] as const;
export const StatementModalitySchema = z.enum(STATEMENT_MODALITIES);
export type StatementModality = z.infer<typeof StatementModalitySchema>;

export const STATEMENT_MODALITY_LABELS: Record<StatementModality, string> = {
  asserted: 'States it as fact',
  negated: 'Denies it',
  speculative: 'A guess',
  future_intent: 'Intended, not done',
  conditional: 'Depends on a condition',
  attributed: 'Reported from someone else',
  requested: 'Asked for, not yet done',
  corrected: 'Corrects an earlier statement',
};

// ---------------------------------------------------------------- conflicts

/**
 * What kind of disagreement two statements of one case make. Not every disagreement is a contradiction: a later
 * statement can simply be an update, two sources can describe one thing differently, and some wording is ambiguous.
 * A conflict always keeps both sides and where each came from.
 */
export const CONFLICT_CLASSES = [
  /** One side says it happened or holds, the other says it did not, about the same thing at the same time. */
  'direct_contradiction',
  /** The state changed: an earlier statement was true then and a later one is true now (success, then failure). */
  'temporal_update',
  /** Two sources (customer and engineer, person and tool) describe the same thing differently. */
  'source_disagreement',
  /** The wording allows more than one reading, so a conflict cannot be told from a mere difference in phrasing. */
  'ambiguous_wording',
  /** Both sides stand and nothing in the record settles which one is right. */
  'unresolved_conflict',
  /** The author, or someone else, withdrew or corrected the earlier statement. */
  'corrected_information',
] as const;
export const ConflictClassSchema = z.enum(CONFLICT_CLASSES);
export type ConflictClass = z.infer<typeof ConflictClassSchema>;

export const CONFLICT_CLASS_LABELS: Record<ConflictClass, string> = {
  direct_contradiction: 'Direct contradiction',
  temporal_update: 'Changed over time',
  source_disagreement: 'Sources disagree',
  ambiguous_wording: 'Ambiguous wording',
  unresolved_conflict: 'Unresolved conflict',
  corrected_information: 'Corrected',
};

/** One side of a conflict: what it states, who said it, when, and exactly where in the stored text. */
export const ConflictSideSchema = z.object({
  eventId: IdSchema,
  participantRole: ParticipantRoleSchema,
  timestamp: IsoTimestampSchema,
  /** What this side states, in plain words (bounded; never more than the excerpt supports). */
  statement: z.string().min(1).max(300),
  /** What both sides are about, as a short name: the label of a signal pair, or of an attribute such as the number of users. */
  subject: z.string().min(1).max(120),
  /** Whether this side asserts the subject or denies it. */
  polarity: z.enum(['asserts', 'denies']),
  modality: StatementModalitySchema,
  sourceRef: SourceRefSchema,
});
export type ConflictSide = z.infer<typeof ConflictSideSchema>;

export const ConflictSchema = z.object({
  id: IdSchema,
  class: ConflictClassSchema,
  /** The thing the two sides disagree about. */
  subject: z.string().min(1).max(120),
  /** Earlier side first. A conflict never leaves out a side. */
  sides: z.tuple([ConflictSideSchema, ConflictSideSchema]),
  /**
   * Which side the record favours: the later one for an update or a correction, `null` when the record does not settle
   * it (an unresolved conflict, ambiguous wording, two sources).
   */
  favours: z.enum(['first', 'second']).nullable(),
  /** Why these two statements were set against each other, in words a reviewer can check. */
  explanation: z.string().min(1).max(400),
  uncertainty: z.object({ level: LevelSchema, note: z.string().min(1).max(300) }),
  /** The rule that found it. */
  ruleId: z.string().min(1).max(80),
});
export type Conflict = z.infer<typeof ConflictSchema>;

// ---------------------------------------------------------------- temporal findings

/**
 * A conclusion that needs more than one event, with everything it rests on. It is always computed from a temporal view,
 * so it names only events known at the time it speaks of.
 */
export const TEMPORAL_RULES = [
  'requested_never_completed',
  'evidence_available_before_decision',
  'step_only_after_escalation',
  'recommendation_contradicted_by_earlier_observation',
  'failed_step_repeated',
  'rejected_hypothesis_reused',
  'customer_correction_changed_cause',
  'earliest_missed_moment',
] as const;
export const TemporalRuleSchema = z.enum(TEMPORAL_RULES);
export type TemporalRule = z.infer<typeof TemporalRuleSchema>;

export const TemporalFindingSchema = z.object({
  id: IdSchema,
  rule: TemporalRuleSchema,
  /** The events considered, in time order, each with the part of it that matters. */
  events: z
    .array(
      z.object({
        eventId: IdSchema,
        timestamp: IsoTimestampSchema,
        role: z.string().min(1).max(60),
        sourceRef: SourceRefSchema,
      }),
    )
    .min(1)
    .max(12),
  /** The instant the conclusion is about: nothing after it was used. */
  asOf: IsoTimestampSchema,
  /** What was known at that instant that bears on the conclusion, in words. */
  knownThen: z.string().min(1).max(500),
  conclusion: z.string().min(1).max(500),
  uncertainty: z.object({ level: LevelSchema, note: z.string().min(1).max(300) }),
  /** Evidence ids the conclusion cites. */
  evidenceIds: z.array(IdSchema).max(20),
});
export type TemporalFinding = z.infer<typeof TemporalFindingSchema>;
