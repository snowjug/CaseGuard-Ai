import { z } from 'zod';
import {
  AgentNameSchema,
  CounterfactualStrategySchema,
  EvidenceCategorySchema,
  ForkCategorySchema,
  HypothesisCategorySchema,
  HypothesisStatusSchema,
  LevelSchema,
  QualityDimensionKeySchema,
  type AgentName,
} from '@caseguard/schemas';

/**
 * Output contracts for every agent. They are intentionally compact and "strict-mode friendly": no
 * optional properties (use nullable), no records, no numeric probabilities from the model. Every
 * object is strict so unexpected keys are a schema violation. Bounds here are enforced by our own
 * validation (the JSON Schema sent to the model drops them because strict structured output does
 * not support length keywords).
 *
 * Citation convention: fields named `eventId(s)`, `evidenceIds`, `claimId(s)`, `...ActionKey` and
 * `triggerSignalIds` etc. are references that the citation validator resolves against the context.
 */

const Id = z.string().min(1).max(120);
const Ids = (max: number) => z.array(Id).max(max);
const Text = (max: number) => z.string().min(1).max(max);

export const UncertaintySchema = z.strictObject({ level: LevelSchema, note: Text(300) });
export type Uncertainty = z.infer<typeof UncertaintySchema>;

// ---------------------------------------------------------------- timeline analyzer

export const TimelineAnalysisSchema = z.strictObject({
  summary: Text(800),
  keyMoments: z.array(z.strictObject({ eventId: Id, label: Text(120), note: Text(300) })).max(15),
  delays: z
    .array(
      z.strictObject({
        fromEventId: Id,
        toEventId: Id,
        minutes: z.number().int().min(0).max(525_600),
        note: Text(240),
      }),
    )
    .max(15),
  repeatedDiagnostics: z
    .array(z.strictObject({ eventIds: z.array(Id).min(2).max(10), note: Text(240) }))
    .max(15),
  uncertainty: UncertaintySchema,
});
export type TimelineAnalysis = z.infer<typeof TimelineAnalysisSchema>;

// ---------------------------------------------------------------- evidence classifier

export const EvidenceClassificationSchema = z.strictObject({
  classifications: z
    .array(
      z.strictObject({
        claimId: Id,
        category: EvidenceCategorySchema,
        confidence: LevelSchema,
        rationale: Text(400),
        eventIds: Ids(10),
        evidenceIds: Ids(10),
      }),
    )
    .max(150),
  uncertainty: UncertaintySchema,
});
export type EvidenceClassification = z.infer<typeof EvidenceClassificationSchema>;

// ---------------------------------------------------------------- hypothesis generator

export const HypothesisProposalsSchema = z.strictObject({
  hypotheses: z
    .array(
      z.strictObject({
        /** Knowledge-pack hypothesis id, or null for a novel candidate (always an AI inference). */
        key: z.string().min(1).max(80).nullable(),
        name: Text(120),
        description: Text(400),
        category: HypothesisCategorySchema,
        status: HypothesisStatusSchema,
        likelihood: LevelSchema,
        rationale: Text(500),
        supportingEvidenceIds: Ids(12),
        contradictingEvidenceIds: Ids(12),
        eventIds: Ids(12),
        missingEvidence: z.array(Text(200)).max(8),
        cheapestSafeActionKey: z.string().min(1).max(80).nullable(),
      }),
    )
    .min(1)
    .max(10),
  uncertainty: UncertaintySchema,
});
export type HypothesisProposals = z.infer<typeof HypothesisProposalsSchema>;

// ---------------------------------------------------------------- decision-fork detector

export const ForkProposalsSchema = z.strictObject({
  forks: z
    .array(
      z.strictObject({
        eventId: Id,
        category: ForkCategorySchema,
        severity: LevelSchema,
        title: Text(160),
        rationale: Text(600),
        evidenceIds: Ids(12),
        alternativeActionKey: z.string().min(1).max(80).nullable(),
      }),
    )
    .max(20),
  uncertainty: UncertaintySchema,
});
export type ForkProposals = z.infer<typeof ForkProposalsSchema>;

// ---------------------------------------------------------------- counterfactual simulator

export const CounterfactualProposalSchema = z.strictObject({
  forkEventId: Id,
  strategy: CounterfactualStrategySchema,
  steps: z
    .array(
      z.strictObject({
        order: z.number().int().min(1).max(20),
        actionKey: z.string().min(1).max(80),
        rationale: Text(600),
        evidenceUsedIds: Ids(10),
        expectedOutcome: Text(300),
        /** Id of the knowledge-pack outcome the step is expected to produce (null for steps with no defined outcomes). */
        expectedOutcomeId: z.string().min(1).max(80).nullable(),
        assumptions: z.array(Text(300)).max(6),
      }),
    )
    .max(12),
  assumptions: z.array(Text(300)).min(1).max(8),
  /** Both must be true: every consequence in the path is simulated and estimated. */
  labels: z.strictObject({ simulated: z.boolean(), estimated: z.boolean() }),
  uncertainty: UncertaintySchema,
});
export type CounterfactualProposal = z.infer<typeof CounterfactualProposalSchema>;

// ---------------------------------------------------------------- quality judge

export const QualityJudgementSchema = z.strictObject({
  findings: z
    .array(
      z.strictObject({
        dimension: QualityDimensionKeySchema,
        severity: LevelSchema,
        finding: Text(500),
        eventIds: Ids(10),
        evidenceIds: Ids(10),
        claimIds: Ids(10),
        suggestedImprovement: Text(400).nullable(),
        suggestedActionKey: z.string().min(1).max(80).nullable(),
      }),
    )
    .max(20),
  strengths: z
    .array(
      z.strictObject({
        dimension: QualityDimensionKeySchema,
        note: Text(300),
        eventIds: Ids(10),
        evidenceIds: Ids(10),
      }),
    )
    .max(10),
  limitations: z.array(Text(300)).min(1).max(6),
  uncertainty: UncertaintySchema,
});
export type QualityJudgement = z.infer<typeof QualityJudgementSchema>;

// ---------------------------------------------------------------- SkillDNA extractor

export const SkillProposalSchema = z.strictObject({
  name: z.string().min(5).max(160),
  description: Text(800),
  triggerSignalIds: z.array(z.string().min(1).max(80)).min(1).max(10),
  minimumEvidenceRequirementIds: z.array(z.string().min(1).max(80)).max(10),
  steps: z
    .array(
      z.strictObject({
        order: z.number().int().min(1).max(20),
        title: Text(160),
        instruction: Text(500),
        actionKey: z.string().min(1).max(80).nullable(),
        eventIds: Ids(8),
        evidenceIds: Ids(8),
      }),
    )
    .min(1)
    .max(10),
  stopConditions: z.array(Text(300)).max(8),
  successConditions: z.array(Text(300)).max(8),
  escalationConditions: z.array(Text(300)).max(8),
  safetyConstraints: z.array(Text(300)).min(1).max(10),
  sourceEventIds: z.array(Id).min(1).max(20),
  /** Must be true: a proposal is never published without a human reviewer. */
  requiresHumanApproval: z.boolean(),
  uncertainty: UncertaintySchema,
});
export type SkillProposal = z.infer<typeof SkillProposalSchema>;

// ---------------------------------------------------------------- communication coach

const CoachingNoteSchema = z.strictObject({
  title: Text(160),
  detail: Text(500),
  eventIds: Ids(10),
  evidenceIds: Ids(10),
  claimIds: Ids(10),
});
export type CoachingNote = z.infer<typeof CoachingNoteSchema>;

export const CoachingNotesSchema = z.strictObject({
  summary: Text(600),
  wentWell: z.array(CoachingNoteSchema).max(6),
  missedOpportunity: CoachingNoteSchema.nullable(),
  evidenceQuality: z.array(CoachingNoteSchema).max(6),
  reasoningImprovements: z.array(CoachingNoteSchema).max(6),
  communicationImprovements: z.array(CoachingNoteSchema).max(6),
  customerEffortImprovements: z.array(CoachingNoteSchema).max(6),
  recommendedNextActionKey: z.string().min(1).max(80).nullable(),
  limitations: z.array(Text(300)).min(1).max(6),
  uncertainty: UncertaintySchema,
});
export type CoachingNotes = z.infer<typeof CoachingNotesSchema>;

// ---------------------------------------------------------------- deterministic-only agents

export const ROUTE_TIERS = ['deterministic', 'cheap', 'strong', 'rule'] as const;
export const RouteTierSchema = z.enum(ROUTE_TIERS);
export type RouteTier = z.infer<typeof RouteTierSchema>;

export const TokenGovernorDecisionSchema = z.strictObject({
  allowed: z.boolean(),
  reason: Text(300),
  tier: RouteTierSchema,
  model: Text(120),
  limits: z.strictObject({
    maxInputTokens: z.number().int().min(0),
    maxOutputTokens: z.number().int().min(0),
    maxRetries: z.number().int().min(0),
    timeoutMs: z.number().int().min(0),
  }),
  estimatedInputTokens: z.number().int().min(0),
});
export type TokenGovernorDecision = z.infer<typeof TokenGovernorDecisionSchema>;

export const ISSUE_KINDS = [
  'schema',
  'citation',
  'temporal',
  'policy',
  'groundedness',
  'injection',
  'size',
] as const;
export const IssueKindSchema = z.enum(ISSUE_KINDS);
export type IssueKind = z.infer<typeof IssueKindSchema>;

export const SafetyVerdictSchema = z.strictObject({
  verdict: z.enum(['pass', 'block']),
  checkedAgent: AgentNameSchema,
  rulesVersion: Text(40),
  issues: z
    .array(
      z.strictObject({
        kind: IssueKindSchema,
        code: Text(60),
        path: z.string().max(200),
        message: Text(300),
      }),
    )
    .max(50),
});
export type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;

// ---------------------------------------------------------------- registry

export interface AgentOutputs {
  timeline_analyzer: TimelineAnalysis;
  evidence_classifier: EvidenceClassification;
  hypothesis_generator: HypothesisProposals;
  decision_fork_detector: ForkProposals;
  counterfactual_simulator: CounterfactualProposal;
  quality_judge: QualityJudgement;
  skilldna_extractor: SkillProposal;
  communication_coach: CoachingNotes;
  token_governor: TokenGovernorDecision;
  safety_policy_validator: SafetyVerdict;
}

export type AgentOutputOf<A extends AgentName> = AgentOutputs[A];

export const OUTPUT_SCHEMAS: { [A in AgentName]: z.ZodType<AgentOutputs[A]> } = {
  timeline_analyzer: TimelineAnalysisSchema,
  evidence_classifier: EvidenceClassificationSchema,
  hypothesis_generator: HypothesisProposalsSchema,
  decision_fork_detector: ForkProposalsSchema,
  counterfactual_simulator: CounterfactualProposalSchema,
  quality_judge: QualityJudgementSchema,
  skilldna_extractor: SkillProposalSchema,
  communication_coach: CoachingNotesSchema,
  token_governor: TokenGovernorDecisionSchema,
  safety_policy_validator: SafetyVerdictSchema,
};

export const OUTPUT_SCHEMA_IDS: Record<AgentName, string> = {
  timeline_analyzer: 'caseguard.timeline-analysis.v1',
  evidence_classifier: 'caseguard.evidence-classification.v1',
  hypothesis_generator: 'caseguard.hypothesis-proposals.v1',
  decision_fork_detector: 'caseguard.fork-proposals.v1',
  counterfactual_simulator: 'caseguard.counterfactual-proposal.v1',
  quality_judge: 'caseguard.quality-judgement.v1',
  skilldna_extractor: 'caseguard.skill-proposal.v1',
  communication_coach: 'caseguard.coaching-notes.v1',
  token_governor: 'caseguard.token-governor-decision.v1',
  safety_policy_validator: 'caseguard.safety-verdict.v1',
};
