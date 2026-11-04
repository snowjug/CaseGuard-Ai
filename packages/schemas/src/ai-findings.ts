import { z } from 'zod';
import { IdSchema, SourceFieldSchema } from './common';
import { ConflictClassSchema } from './conflicts';
import { CounterfactualBasisSchema } from './counterfactual';
import {
  AgentNameSchema,
  LevelSchema,
  ParticipantRoleSchema,
  PrioritySchema,
  ProviderKindSchema,
} from './enums';
import { SemverSchema } from './skill';

/**
 * Contracts of the optional model-assisted review (wave 2). A model may PROPOSE findings, check them and critique them;
 * the deterministic engine stays the source of truth. Two families of schema live here and must not be confused:
 *
 * - the **proposal schemas** (`Proposed*`, `CriticResult`, `CaseReasonerOutput`, `CaseCriticOutput`) describe what a
 *   model may return. They are strict objects without optional keys (nullable instead), carry no numeric probability
 *   and no field the server computes, and are converted to a strict JSON Schema for structured output;
 * - the **finding schema** (`AiFinding`) is what the server stores and serves after the proposal passed grounding
 *   checks and the hybrid policy. A model never supplies any of its server-computed parts.
 *
 * Nothing here approves, accepts or rejects anything: a person with `evidence:review` decides.
 */

export const FINDING_SCHEMA_VERSION = 'caseguard.ai-finding/1' as const;
/** Version of the model-facing proposal schemas; each proposal type is identified as `<version>#<type>`. */
export const PROPOSAL_SCHEMA_VERSION = 'caseguard.ai-proposal/1' as const;
/** Ids of the two combined outputs, as sent to the model for structured output. */
export const CASE_REASONER_SCHEMA_ID = 'caseguard.case-reasoner.v1' as const;
export const CASE_CRITIC_SCHEMA_ID = 'caseguard.case-critic.v1' as const;

// ---------------------------------------------------------------- vocabulary

export const FINDING_TYPES = [
  'signal',
  'contradiction',
  'missing_evidence',
  'missed_step',
  'counterfactual',
  'recommendation',
  'critic_result',
  'case_synthesis',
] as const;
export const FindingTypeSchema = z.enum(FINDING_TYPES);
export type FindingType = z.infer<typeof FindingTypeSchema>;
export const FINDING_TYPE_LABELS: Record<FindingType, string> = {
  signal: 'A sign in the record',
  contradiction: 'Statements that disagree',
  missing_evidence: 'Evidence that was missing',
  missed_step: 'A step that was available',
  counterfactual: 'What could have been done instead',
  recommendation: 'A suggested next step',
  critic_result: 'A second look',
  case_synthesis: 'Summary of the case',
};

export const PROPOSAL_SCHEMA_IDS: Record<FindingType, string> = {
  signal: `${PROPOSAL_SCHEMA_VERSION}#signal`,
  contradiction: `${PROPOSAL_SCHEMA_VERSION}#contradiction`,
  missing_evidence: `${PROPOSAL_SCHEMA_VERSION}#missing_evidence`,
  missed_step: `${PROPOSAL_SCHEMA_VERSION}#missed_step`,
  counterfactual: `${PROPOSAL_SCHEMA_VERSION}#counterfactual`,
  recommendation: `${PROPOSAL_SCHEMA_VERSION}#recommendation`,
  critic_result: `${PROPOSAL_SCHEMA_VERSION}#critic_result`,
  case_synthesis: `${PROPOSAL_SCHEMA_VERSION}#case_synthesis`,
};

/**
 * How a finding stands next to what the deterministic engine found independently. `DETERMINISTIC` is the status of
 * the engine's own item (shown next to a model finding that agrees or disagrees with it); a model finding is never
 * `DETERMINISTIC`. `REJECTED` is what a reviewer's rejection gives; the policy never produces it.
 */
export const HYBRID_STATUSES = [
  'DETERMINISTIC',
  'MODEL_CORROBORATED',
  'MODEL_PROPOSED',
  'CONFLICTING',
  'REJECTED',
  'NEEDS_HUMAN_REVIEW',
] as const;
export const HybridStatusSchema = z.enum(HYBRID_STATUSES);
export type HybridStatus = z.infer<typeof HybridStatusSchema>;
export const HYBRID_STATUS_LABELS: Record<HybridStatus, string> = {
  DETERMINISTIC: 'Found by the rules engine',
  MODEL_CORROBORATED: 'AI finding the rules engine confirms',
  MODEL_PROPOSED: 'AI suggestion, not confirmed',
  CONFLICTING: 'AI and rules engine disagree',
  REJECTED: 'Rejected by a reviewer',
  NEEDS_HUMAN_REVIEW: 'Needs a person to decide',
};
export const HYBRID_STATUS_DESCRIPTIONS: Record<HybridStatus, string> = {
  DETERMINISTIC:
    'The rules engine found this on its own, from the record, with the same result every time.',
  MODEL_CORROBORATED:
    'The AI proposed this and the rules engine independently found the same thing in the record.',
  MODEL_PROPOSED:
    'The AI proposed this. The rules engine neither confirms nor contradicts it, so it rests on the quoted record alone.',
  CONFLICTING:
    'The AI and the rules engine disagree about this. Both are shown and neither wins; a person decides.',
  REJECTED: 'A reviewer rejected this finding.',
  NEEDS_HUMAN_REVIEW:
    'This needs a person before anyone relies on it: the rules engine does not support it, or the second look questioned it.',
};

/** What the model says its confidence rests on. A guess from sequence, absence or general knowledge is never "high". */
export const CONFIDENCE_BASES = [
  'stated_in_record',
  'paraphrase_of_record',
  'inferred_from_sequence',
  'inferred_from_absence',
  'general_knowledge',
] as const;
export const ConfidenceBasisSchema = z.enum(CONFIDENCE_BASES);
export type ConfidenceBasis = z.infer<typeof ConfidenceBasisSchema>;
export const CONFIDENCE_BASIS_LABELS: Record<ConfidenceBasis, string> = {
  stated_in_record: 'Stated in the record',
  paraphrase_of_record: 'Paraphrases the record',
  inferred_from_sequence: 'Inferred from the order of events',
  inferred_from_absence: 'Inferred from what is missing',
  general_knowledge: 'General knowledge, not from this record',
};

/**
 * What a model may claim for a counterfactual it proposes: its own estimate, and nothing else. The vocabulary
 * (`COUNTERFACTUAL_BASES`: measured, deterministic_estimate, model_estimate, illustrative) belongs to
 * `./counterfactual`; claiming `measured` or `deterministic_estimate` is reported as `model_basis_overclaim`.
 */
export const MODEL_COUNTERFACTUAL_BASES = ['model_estimate'] as const;
export const ModelCounterfactualBasisSchema = CounterfactualBasisSchema.extract(
  MODEL_COUNTERFACTUAL_BASES,
);
export type ModelCounterfactualBasis = z.infer<typeof ModelCounterfactualBasisSchema>;

export const CORROBORATION_STATES = [
  'corroborated',
  'not_found',
  'conflicts',
  'not_applicable',
] as const;
export const CorroborationStateSchema = z.enum(CORROBORATION_STATES);
export type CorroborationState = z.infer<typeof CorroborationStateSchema>;
export const CORROBORATION_STATE_LABELS: Record<CorroborationState, string> = {
  corroborated: 'The rules engine found the same',
  not_found: 'The rules engine did not find it',
  conflicts: 'The rules engine disagrees',
  not_applicable: 'The rules engine has nothing to compare',
};

export const FINDING_REVIEW_STATES = [
  'pending',
  'accepted',
  'rejected',
  'edited',
  'evidence_requested',
  'uncertain',
  'not_applicable',
] as const;
export const FindingReviewStateSchema = z.enum(FINDING_REVIEW_STATES);
export type FindingReviewState = z.infer<typeof FindingReviewStateSchema>;
export const FINDING_REVIEW_STATE_LABELS: Record<FindingReviewState, string> = {
  pending: 'Waiting for review',
  accepted: 'Accepted',
  rejected: 'Rejected',
  edited: 'Accepted with changes',
  evidence_requested: 'More evidence requested',
  uncertain: 'Marked uncertain',
  not_applicable: 'Does not apply',
};

export const CRITIQUE_KINDS = [
  'unsupported_claim',
  'missing_evidence',
  'circular_reasoning',
  'premature_closure',
  'alternative_explanation',
  'contradiction',
  'uncertainty_hidden_as_fact',
  'counterfactual_overclaim',
  'weak_recommendation',
  'supported',
] as const;
export const CritiqueKindSchema = z.enum(CRITIQUE_KINDS);
export type CritiqueKind = z.infer<typeof CritiqueKindSchema>;
export const CRITIQUE_KIND_LABELS: Record<CritiqueKind, string> = {
  unsupported_claim: 'Not supported by the record',
  missing_evidence: 'Evidence is missing',
  circular_reasoning: 'The reasoning goes in a circle',
  premature_closure: 'Concludes too early',
  alternative_explanation: 'Another explanation fits',
  contradiction: 'The record says otherwise',
  uncertainty_hidden_as_fact: 'A guess is stated as fact',
  counterfactual_overclaim: 'Claims more than the record allows',
  weak_recommendation: 'A weak recommendation',
  supported: 'Looks supported',
};
/** The critiques that make a proposal need a person. The others are shown as notes and change no status. */
export const ESCALATING_CRITIQUE_KINDS: readonly CritiqueKind[] = [
  'unsupported_claim',
  'circular_reasoning',
  'premature_closure',
  'counterfactual_overclaim',
  'uncertainty_hidden_as_fact',
  'contradiction',
];

export const CRITIC_VERDICTS = ['no_concerns', 'some_concerns', 'serious_concerns'] as const;
export const CriticVerdictSchema = z.enum(CRITIC_VERDICTS);
export type CriticVerdict = z.infer<typeof CriticVerdictSchema>;
export const CRITIC_VERDICT_LABELS: Record<CriticVerdict, string> = {
  no_concerns: 'No concerns',
  some_concerns: 'Some concerns',
  serious_concerns: 'Serious concerns',
};

// ---------------------------------------------------------------- limits

/** Caps that the proposal schemas and the grounding rules both enforce. */
export const PROPOSAL_LIMITS = {
  statement: 300,
  reasoning: 500,
  excerpt: 300,
  evidencePerProposal: 6,
  contradictionNotes: 4,
  signals: 12,
  contradictions: 6,
  missingEvidence: 6,
  missedSteps: 6,
  counterfactuals: 4,
  recommendations: 6,
  critiques: 12,
  keyPoints: 6,
  openQuestions: 5,
} as const;

// ---------------------------------------------------------------- what the model may return

const Text = (max: number) => z.string().min(1).max(max);
/** A reference the model wrote. Whether it names a real event or a pack id is checked by the grounding rules. */
const Ref = z.string().min(1).max(120);

/** Model-local id: the server re-keys every proposal, so this only has to be unique inside one reply. */
export const ProposalLocalIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);

/** A VERBATIM quotation. The model never supplies offsets, hashes or flags: the server finds the quotation itself. */
export const ProposedCitationSchema = z.strictObject({
  eventId: Ref,
  excerpt: z.string().min(3).max(PROPOSAL_LIMITS.excerpt),
});
export type ProposedCitation = z.infer<typeof ProposedCitationSchema>;

export const ProposedUncertaintySchema = z.strictObject({ level: LevelSchema, note: Text(300) });
export type ProposedUncertainty = z.infer<typeof ProposedUncertaintySchema>;

/** What in the record cuts against a proposal. */
export const ProposedContradictionNoteSchema = z.strictObject({ eventId: Ref, note: Text(300) });
export type ProposedContradictionNote = z.infer<typeof ProposedContradictionNoteSchema>;

const evidenceField = z
  .array(ProposedCitationSchema)
  .min(1)
  .max(PROPOSAL_LIMITS.evidencePerProposal);

const headFields = {
  id: ProposalLocalIdSchema,
  statement: Text(PROPOSAL_LIMITS.statement),
} as const;

const tailFields = {
  evidence: evidenceField,
  reasoning: Text(PROPOSAL_LIMITS.reasoning),
  confidenceBasis: ConfidenceBasisSchema,
  confidence: LevelSchema,
  uncertainty: ProposedUncertaintySchema,
  contradictions: z.array(ProposedContradictionNoteSchema).max(PROPOSAL_LIMITS.contradictionNotes),
} as const;

/** The type-specific parts. They are also the `payload` of the stored finding. */
const signalPayload = {
  /** A knowledge-pack signal id from the allow-list given in the prompt. */
  signalId: Text(80),
  eventId: Ref,
} as const;

const sideSchema = z.strictObject({ eventId: Ref, statement: Text(PROPOSAL_LIMITS.statement) });

const contradictionPayload = {
  conflictClass: ConflictClassSchema,
  subject: Text(120),
  /** Exactly two. */
  sides: z.array(sideSchema).min(2).max(2),
} as const;

const missingEvidencePayload = {
  /** A knowledge-pack requirement id (`req.*`), or null when the requirement is not one the pack names. */
  requirementId: Text(80).nullable(),
  missing: Text(300),
  /** The decision that needed it. */
  neededByEventId: Ref,
} as const;

const missedStepPayload = {
  /** A knowledge-pack action id (`act.*`), or null. */
  actionId: Text(80).nullable(),
  step: Text(300),
  decisionEventId: Ref,
  /** What was already known at the decision: events strictly before it. */
  availableEventIds: z.array(Ref).max(8),
} as const;

const counterfactualPayload = {
  decisionEventId: Ref,
  alternativeAction: Text(300),
  informationThen: Text(400),
  expectedImmediateEffect: Text(300),
  plausibleDownstreamEffect: Text(300),
  feasible: z.enum(['yes', 'no', 'unknown']),
  constraints: z.array(Text(200)).max(4),
  skillId: Text(80).nullable(),
  validationNeeded: Text(300),
  /** A model may only say it estimated or illustrated. There is no numeric field: it cannot state saved minutes. */
  basis: ModelCounterfactualBasisSchema,
} as const;

const recommendationPayload = {
  action: Text(300),
  rationale: Text(400),
  ownerRole: ParticipantRoleSchema.nullable(),
  priority: PrioritySchema,
} as const;

export const CritiqueSchema = z.strictObject({
  /** The id of a conclusion under review. Null reads as "about nothing in particular", which is refused. */
  targetId: Text(40).nullable(),
  kind: CritiqueKindSchema,
  explanation: Text(400),
  /** Every critique cites events; an empty list is refused by the grounding rules, not by the schema. */
  evidence: z.array(ProposedCitationSchema).max(PROPOSAL_LIMITS.evidencePerProposal),
  /** Only for `alternative_explanation`: a knowledge-pack hypothesis id (`hyp.*`), never a new story. */
  alternativeHypothesisId: Text(80).nullable(),
});
export type Critique = z.infer<typeof CritiqueSchema>;

const criticPayload = {
  verdict: CriticVerdictSchema,
  critiques: z.array(CritiqueSchema).max(PROPOSAL_LIMITS.critiques),
} as const;

const synthesisPayload = {
  summary: Text(800),
  keyPoints: z
    .array(z.strictObject({ point: Text(300), evidence: evidenceField }))
    .max(PROPOSAL_LIMITS.keyPoints),
  openQuestions: z.array(Text(300)).max(PROPOSAL_LIMITS.openQuestions),
} as const;

export const ProposedSignalSchema = z.strictObject({
  ...headFields,
  type: z.literal('signal'),
  ...signalPayload,
  ...tailFields,
});
export const ProposedContradictionSchema = z.strictObject({
  ...headFields,
  type: z.literal('contradiction'),
  ...contradictionPayload,
  ...tailFields,
});
export const ProposedMissingEvidenceSchema = z.strictObject({
  ...headFields,
  type: z.literal('missing_evidence'),
  ...missingEvidencePayload,
  ...tailFields,
});
export const ProposedMissedStepSchema = z.strictObject({
  ...headFields,
  type: z.literal('missed_step'),
  ...missedStepPayload,
  ...tailFields,
});
export const ProposedCounterfactualSchema = z.strictObject({
  ...headFields,
  type: z.literal('counterfactual'),
  ...counterfactualPayload,
  ...tailFields,
});
export const ProposedRecommendationSchema = z.strictObject({
  ...headFields,
  type: z.literal('recommendation'),
  ...recommendationPayload,
  ...tailFields,
});
export const CriticResultSchema = z.strictObject({
  ...headFields,
  type: z.literal('critic_result'),
  ...criticPayload,
  ...tailFields,
});
export const CaseSynthesisSchema = z.strictObject({
  ...headFields,
  type: z.literal('case_synthesis'),
  ...synthesisPayload,
  ...tailFields,
});

export type ProposedSignal = z.infer<typeof ProposedSignalSchema>;
export type ProposedContradiction = z.infer<typeof ProposedContradictionSchema>;
export type ProposedMissingEvidence = z.infer<typeof ProposedMissingEvidenceSchema>;
export type ProposedMissedStep = z.infer<typeof ProposedMissedStepSchema>;
export type ProposedCounterfactual = z.infer<typeof ProposedCounterfactualSchema>;
export type ProposedRecommendation = z.infer<typeof ProposedRecommendationSchema>;
export type CriticResult = z.infer<typeof CriticResultSchema>;
export type CaseSynthesis = z.infer<typeof CaseSynthesisSchema>;

/** Every proposal the reasoner can make (the critic's result and the synthesis are not claims about one event). */
export type ReasonerProposal =
  | ProposedSignal
  | ProposedContradiction
  | ProposedMissingEvidence
  | ProposedMissedStep
  | ProposedCounterfactual
  | ProposedRecommendation
  | CaseSynthesis;
export type AnyProposal = ReasonerProposal | CriticResult;

/** The schema of each proposal type, by the value of its `type` field. */
export const PROPOSAL_SCHEMAS = {
  signal: ProposedSignalSchema,
  contradiction: ProposedContradictionSchema,
  missing_evidence: ProposedMissingEvidenceSchema,
  missed_step: ProposedMissedStepSchema,
  counterfactual: ProposedCounterfactualSchema,
  recommendation: ProposedRecommendationSchema,
  critic_result: CriticResultSchema,
  case_synthesis: CaseSynthesisSchema,
} as const satisfies Record<FindingType, z.ZodType>;

/** What the reasoner returns: one array per type, and optionally one synthesis. The top-level note carries a reason when there is nothing. */
export const CaseReasonerOutputSchema = z.strictObject({
  signals: z.array(ProposedSignalSchema).max(PROPOSAL_LIMITS.signals),
  contradictions: z.array(ProposedContradictionSchema).max(PROPOSAL_LIMITS.contradictions),
  missingEvidence: z.array(ProposedMissingEvidenceSchema).max(PROPOSAL_LIMITS.missingEvidence),
  missedSteps: z.array(ProposedMissedStepSchema).max(PROPOSAL_LIMITS.missedSteps),
  counterfactuals: z.array(ProposedCounterfactualSchema).max(PROPOSAL_LIMITS.counterfactuals),
  recommendations: z.array(ProposedRecommendationSchema).max(PROPOSAL_LIMITS.recommendations),
  synthesis: CaseSynthesisSchema.nullable(),
  uncertainty: ProposedUncertaintySchema,
});
export type CaseReasonerOutput = z.infer<typeof CaseReasonerOutputSchema>;

/** What the critic returns: one result about the conclusions under review, or null when it has nothing to say. */
export const CaseCriticOutputSchema = z.strictObject({
  result: CriticResultSchema.nullable(),
  uncertainty: ProposedUncertaintySchema,
});
export type CaseCriticOutput = z.infer<typeof CaseCriticOutputSchema>;

/** The array of `CaseReasonerOutput` that holds each type (the synthesis is a single nullable value). */
export const REASONER_ARRAY_KEYS = {
  signal: 'signals',
  contradiction: 'contradictions',
  missing_evidence: 'missingEvidence',
  missed_step: 'missedSteps',
  counterfactual: 'counterfactuals',
  recommendation: 'recommendations',
} as const;
export type ReasonerArrayKey = (typeof REASONER_ARRAY_KEYS)[keyof typeof REASONER_ARRAY_KEYS];

/** The keys a reasoner reply may have, in the order of the schema. */
export const CASE_REASONER_KEYS = [
  'signals',
  'contradictions',
  'missingEvidence',
  'missedSteps',
  'counterfactuals',
  'recommendations',
  'synthesis',
  'uncertainty',
] as const;
export const CASE_CRITIC_KEYS = ['result', 'uncertainty'] as const;

// ---------------------------------------------------------------- names only the server may write

/**
 * Fields the server computes. A model that names one (to approve itself, to claim the engine agrees, to set a
 * review state) is reported as `prohibited_field` rather than as a generic schema error.
 */
export const PROHIBITED_MODEL_FIELDS = [
  'validationStatus',
  'modelOnly',
  'deterministicCorroboration',
  'hybridStatus',
  'status',
  'approved',
  'accepted',
  'reviewState',
] as const;

const normaliseKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
const PROHIBITED_KEYS: ReadonlySet<string> = new Set(PROHIBITED_MODEL_FIELDS.map(normaliseKey));

const MAX_WALK_NODES = 5_000;
const MAX_WALK_DEPTH = 12;

/**
 * Paths at which a value names a server-computed field, at any depth. Case, underscores and hyphens do not hide a name
 * (`review_state`, `Approved`). Bounded in nodes and depth so a hostile reply cannot make the walk expensive.
 */
export function findProhibitedFields(value: unknown): string[] {
  const found: string[] = [];
  let visited = 0;
  const visit = (node: unknown, path: string, depth: number): void => {
    if (visited++ >= MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = path === '' ? key : `${path}.${key}`;
      if (PROHIBITED_KEYS.has(normaliseKey(key)) && found.length < 20) found.push(childPath);
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, '', 0);
  return found;
}

// ---------------------------------------------------------------- what the server stores and serves

/**
 * A quotation the server found in the record. `stored_text` means the excerpt is exactly the stored text at
 * `[start, end)` of `field`. `redacted_view` means the quotation is in the redacted text the model was shown but not in
 * the stored text (it quotes something the redaction replaced), so there are no offsets: the excerpt shows what the
 * model saw. `sourceHash` is the SHA-256 of the text that was checked, so a later edit of the event is detectable.
 */
export const AiFindingEvidenceSchema = z
  .strictObject({
    eventId: Ref,
    excerpt: z.string().min(1).max(600),
    verifiedIn: z.enum(['stored_text', 'redacted_view']),
    field: SourceFieldSchema.nullable(),
    start: z.number().int().min(0).nullable(),
    end: z.number().int().min(0).nullable(),
    verified: z.literal(true),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .superRefine((evidence, ctx) => {
    const located = evidence.field !== null && evidence.start !== null && evidence.end !== null;
    const none = evidence.field === null && evidence.start === null && evidence.end === null;
    if (evidence.verifiedIn === 'stored_text' ? !located : !none) {
      ctx.addIssue({
        code: 'custom',
        message:
          evidence.verifiedIn === 'stored_text'
            ? 'A quotation verified in the stored text has a field and offsets.'
            : 'A quotation verified only in the redacted view has no field and no offsets.',
      });
    }
  });
export type AiFindingEvidence = z.infer<typeof AiFindingEvidenceSchema>;

export const AiFindingCorroborationSchema = z.strictObject({
  state: CorroborationStateSchema,
  /** The engine's own items that agree (or disagree): they are listed, never altered. */
  by: z
    .array(
      z.strictObject({
        kind: z.string().min(1).max(40),
        id: z.string().min(1).max(160),
        eventIds: z.array(Ref).max(20),
      }),
    )
    .max(20),
});
export type AiFindingCorroboration = z.infer<typeof AiFindingCorroborationSchema>;

export const AiFindingCheckSchema = z.strictObject({
  id: z.string().min(1).max(60),
  passed: z.boolean(),
  detail: z.string().max(300),
});
export type AiFindingCheck = z.infer<typeof AiFindingCheckSchema>;

export const AiFindingCriticNoteSchema = z.strictObject({
  kind: CritiqueKindSchema,
  explanation: Text(400),
  evidence: z.array(AiFindingEvidenceSchema).max(PROPOSAL_LIMITS.evidencePerProposal),
  alternativeHypothesisId: Text(80).nullable(),
});
export type AiFindingCriticNote = z.infer<typeof AiFindingCriticNoteSchema>;

export const AiFindingProvenanceSchema = z.strictObject({
  agent: AgentNameSchema,
  promptVersion: SemverSchema,
  provider: ProviderKindSchema,
  model: z.string().min(1).max(120),
  /** True for the scripted test provider and the deterministic provider: nothing says anything about a real model. */
  simulated: z.boolean(),
  executionId: z.string().min(1).max(120),
});
export type AiFindingProvenance = z.infer<typeof AiFindingProvenanceSchema>;

const findingBase = {
  schemaVersion: z.literal(FINDING_SCHEMA_VERSION),
  /** The server's key, derived from the content. It is never the model's `id`. */
  id: IdSchema,
  statement: Text(PROPOSAL_LIMITS.statement),
  evidence: z.array(AiFindingEvidenceSchema).min(1).max(PROPOSAL_LIMITS.evidencePerProposal),
  reasoning: Text(PROPOSAL_LIMITS.reasoning),
  confidenceBasis: ConfidenceBasisSchema,
  confidence: LevelSchema,
  uncertainty: ProposedUncertaintySchema,
  contradictions: z.array(ProposedContradictionNoteSchema).max(PROPOSAL_LIMITS.contradictionNotes),
  deterministicCorroboration: AiFindingCorroborationSchema,
  /** True unless the engine independently corroborated the finding. */
  modelOnly: z.boolean(),
  /** A finding that fails mechanical validation is never stored, only counted. */
  validationStatus: z.enum(['passed', 'passed_with_notes']),
  hybridStatus: HybridStatusSchema,
  reviewRequired: z.boolean(),
  /** The decision of a person. The model layer only ever writes `pending`. */
  reviewState: FindingReviewStateSchema,
  checks: z.array(AiFindingCheckSchema).max(40),
  /** The critic's critiques that target this finding: shown as "a second look", never as a status change to better. */
  criticNotes: z.array(AiFindingCriticNoteSchema).max(PROPOSAL_LIMITS.critiques),
  provenance: AiFindingProvenanceSchema,
} as const;

const payloadOf = <S extends z.ZodRawShape>(shape: S) => z.strictObject(shape);

/** In a stored finding the quotations of a synthesis and of a critic result are the located ones, like the finding's own. */
const storedSynthesisPayload = {
  summary: Text(800),
  keyPoints: z
    .array(
      z.strictObject({
        point: Text(300),
        evidence: z.array(AiFindingEvidenceSchema).min(1).max(PROPOSAL_LIMITS.evidencePerProposal),
      }),
    )
    .max(PROPOSAL_LIMITS.keyPoints),
  openQuestions: z.array(Text(300)).max(PROPOSAL_LIMITS.openQuestions),
} as const;

const storedCriticPayload = {
  verdict: CriticVerdictSchema,
  critiques: z
    .array(
      z.strictObject({
        targetId: Text(40).nullable(),
        kind: CritiqueKindSchema,
        explanation: Text(400),
        evidence: z.array(AiFindingEvidenceSchema).max(PROPOSAL_LIMITS.evidencePerProposal),
        alternativeHypothesisId: Text(80).nullable(),
      }),
    )
    .max(PROPOSAL_LIMITS.critiques),
} as const;

export const AiFindingSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...findingBase,
    type: z.literal('signal'),
    payload: payloadOf(signalPayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('contradiction'),
    payload: payloadOf(contradictionPayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('missing_evidence'),
    payload: payloadOf(missingEvidencePayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('missed_step'),
    payload: payloadOf(missedStepPayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('counterfactual'),
    payload: payloadOf(counterfactualPayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('recommendation'),
    payload: payloadOf(recommendationPayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('critic_result'),
    payload: payloadOf(storedCriticPayload),
  }),
  z.strictObject({
    ...findingBase,
    type: z.literal('case_synthesis'),
    payload: payloadOf(storedSynthesisPayload),
  }),
]);
export type AiFinding = z.infer<typeof AiFindingSchema>;
