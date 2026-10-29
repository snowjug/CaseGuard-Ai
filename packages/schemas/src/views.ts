import { z } from 'zod';
import {
  IdSchema,
  IsoTimestampSchema,
  ProbabilitySchema,
  RecordMetaSchema,
  pageOf,
} from './common';
import {
  CaseParticipantSchema,
  CaseSchema,
  CaseSourceSchema,
  CaseEventSchema,
  CaseResolutionSchema,
} from './case';
import {
  ClaimSchema,
  DecisionForkSchema,
  EvidenceSchema,
  HypothesisEvidenceLinkSchema,
  HypothesisSchema,
  MissingEvidenceSchema,
} from './analysis';
import {
  ActionKindSchema,
  EffortLevelSchema,
  EventTypeSchema,
  EvidenceCategorySchema,
  ParticipantRoleSchema,
  ProviderKindSchema,
} from './enums';

// ---------------------------------------------------------------- case detail & analysis run

export const CaseDetailSchema = CaseSchema.extend({
  participants: z.array(CaseParticipantSchema),
  source: CaseSourceSchema.pick({
    id: true,
    kind: true,
    fileName: true,
    mediaType: true,
    sizeBytes: true,
    receivedSha256: true,
    storedSha256: true,
    redactionApplied: true,
    redactionReplacements: true,
    synthetic: true,
  }),
  /** Present only when the caller asked for the full case (never inside an `asOf` window). */
  resolution: CaseResolutionSchema.nullable(),
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const AnalysisRunSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  provider: ProviderKindSchema,
  model: z.string(),
  simulated: z.boolean(),
  knowledgePackId: z.string(),
  knowledgePackVersion: z.string(),
  qualityConfigVersion: z.string(),
  actionValueConfigVersion: z.string(),
  /** Hash of (events, pack, configs, provider): identical input never re-runs (idempotent analysis). */
  inputHash: z.string(),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema.nullable(),
  counts: z.object({
    events: z.number().int(),
    evidence: z.number().int(),
    claims: z.number().int(),
    hypotheses: z.number().int(),
    actions: z.number().int(),
    forks: z.number().int(),
    warnings: z.number().int(),
    modelExecutions: z.number().int(),
  }),
  error: z.string().nullable(),
});
export type AnalysisRun = z.infer<typeof AnalysisRunSchema>;

// ---------------------------------------------------------------- timeline

export const TimelineEventSchema = z.object({
  id: IdSchema,
  sequence: z.number().int(),
  timestamp: IsoTimestampSchema,
  type: EventTypeSchema,
  participantRole: ParticipantRoleSchema,
  participantAlias: z.string(),
  title: z.string().nullable(),
  bodyExcerpt: z.string().max(500),
  bodyTruncated: z.boolean(),
  actionKey: z.string().nullable(),
  actionLabel: z.string().nullable(),
  actionKind: ActionKindSchema.nullable(),
  customerEffort: EffortLevelSchema.nullable(),
  destructive: z.boolean(),
  /** Minutes since the previous event; null for the first event. */
  gapMinutes: z.number().min(0).nullable(),
  isDelay: z.boolean(),
  isRepeatedDiagnostic: z.boolean(),
  forkIds: z.array(IdSchema),
  claimIds: z.array(IdSchema),
  evidenceIds: z.array(IdSchema),
  categories: z.array(EvidenceCategorySchema),
  hypothesisEffects: z.array(z.object({ hypothesisId: IdSchema, delta: z.number() })),
  aiTokens: z.number().int().min(0).nullable(),
  simulated: z.literal(false),
});
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;

export const SimulatedTimelineEventSchema = z.object({
  id: IdSchema,
  scenarioId: IdSchema,
  stepIndex: z.number().int(),
  timestamp: IsoTimestampSchema,
  label: z.string(),
  actionKey: z.string(),
  actionKind: ActionKindSchema,
  customerEffort: EffortLevelSchema,
  outcomeLabel: z.string(),
  probability: ProbabilitySchema,
  simulated: z.literal(true),
});
export type SimulatedTimelineEvent = z.infer<typeof SimulatedTimelineEventSchema>;

export const TimelineResponseSchema = z.object({
  caseId: IdSchema,
  asOf: IsoTimestampSchema.nullable(),
  openedAt: IsoTimestampSchema,
  events: z.array(TimelineEventSchema),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
  simulatedEvents: z.array(SimulatedTimelineEventSchema),
  delays: z.array(
    z.object({
      fromEventId: IdSchema,
      toEventId: IdSchema,
      minutes: z.number(),
      reason: z.string(),
    }),
  ),
  repeats: z.array(
    z.object({ eventId: IdSchema, repeatOfEventId: IdSchema, actionKey: z.string().nullable() }),
  ),
  hypothesisSeries: z.array(
    z.object({
      hypothesisId: IdSchema,
      key: z.string(),
      name: z.string(),
      points: z.array(z.object({ at: IsoTimestampSchema, confidence: ProbabilitySchema })),
    }),
  ),
  /** Later events withheld by the temporal boundary: a count, never content. */
  withheldFutureEventCount: z.number().int().min(0),
  knownAtAsOf: z.object({
    evidenceCount: z.number().int(),
    claimCount: z.number().int(),
    criticalMissingCount: z.number().int(),
    openWarningCount: z.number().int(),
  }),
});
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;

export const EventDetailSchema = z.object({
  event: CaseEventSchema,
  claims: z.array(ClaimSchema),
  evidence: z.array(EvidenceSchema),
  inResponseTo: CaseEventSchema.pick({
    id: true,
    timestamp: true,
    type: true,
    title: true,
  }).nullable(),
  responses: z.array(CaseEventSchema.pick({ id: true, timestamp: true, type: true, title: true })),
});
export type EventDetail = z.infer<typeof EventDetailSchema>;

// ---------------------------------------------------------------- ledger / hypotheses views

export const EvidenceLedgerResponseSchema = pageOf(ClaimSchema).extend({
  asOf: IsoTimestampSchema.nullable(),
  counts: z.record(z.string(), z.number().int().min(0)),
  /** Evidence rows referenced by the returned claims, so the client needs no second round trip. */
  evidence: z.array(EvidenceSchema),
  missing: z.array(MissingEvidenceSchema),
});
export type EvidenceLedgerResponse = z.infer<typeof EvidenceLedgerResponseSchema>;

export const ReviewClaimBodySchema = z.object({
  category: EvidenceCategorySchema,
  reason: z.string().min(5).max(1000),
  expectedVersion: z.number().int().min(1),
});
export type ReviewClaimBody = z.infer<typeof ReviewClaimBodySchema>;

export const HypothesesResponseSchema = z.object({
  caseId: IdSchema,
  asOf: IsoTimestampSchema.nullable(),
  items: z.array(HypothesisSchema),
  links: z.array(HypothesisEvidenceLinkSchema),
  evidence: z.array(EvidenceSchema),
  missing: z.array(MissingEvidenceSchema),
  notice: z.string(),
});
export type HypothesesResponse = z.infer<typeof HypothesesResponseSchema>;

export const ForkListResponseSchema = z.object({
  items: z.array(DecisionForkSchema),
  earliestMeaningfulForkId: IdSchema.nullable(),
});
export type ForkListResponse = z.infer<typeof ForkListResponseSchema>;

// ---------------------------------------------------------------- investigation graph

export const GRAPH_LANES = [
  'problem',
  'evidence',
  'hypothesis',
  'actual',
  'counterfactual',
  'outcome',
  'skill',
] as const;
export const GraphLaneSchema = z.enum(GRAPH_LANES);
export type GraphLane = z.infer<typeof GraphLaneSchema>;

export const GraphNodeSchema = z.object({
  id: z.string().max(140),
  kind: z.enum([
    'problem',
    'evidence',
    'hypothesis',
    'action',
    'fork',
    'outcome',
    'counterfactual_step',
    'skill',
  ]),
  lane: GraphLaneSchema,
  label: z.string().max(120),
  detail: z.string().max(600),
  /** Ordinal position along the lane (time order); layout is computed client-side from this. */
  order: z.number().int().min(0),
  timestamp: IsoTimestampSchema.nullable(),
  /** Never colour-only: the UI pairs every status with an icon, label and pattern. */
  status: z.enum(['productive', 'uncertain', 'unsupported', 'missing', 'neutral']),
  simulated: z.boolean(),
  confidence: ProbabilitySchema.nullable(),
  refs: z.array(
    z.object({
      type: z.enum([
        'event',
        'evidence',
        'hypothesis',
        'action',
        'fork',
        'claim',
        'scenario',
        'step',
        'skill',
        'requirement',
      ]),
      id: z.string(),
    }),
  ),
  textAlternative: z.string().max(400),
});
export type GraphNode = z.infer<typeof GraphNodeSchema>;

export const GraphEdgeSchema = z.object({
  id: z.string().max(200),
  from: z.string(),
  to: z.string(),
  kind: z.enum([
    'actual',
    'counterfactual',
    'supports',
    'contradicts',
    'informs',
    'branches',
    'extracts',
  ]),
  label: z.string().max(80).nullable(),
  simulated: z.boolean(),
  strength: ProbabilitySchema.nullable(),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const InvestigationGraphSchema = z.object({
  caseId: IdSchema,
  scenarioId: IdSchema.nullable(),
  asOf: IsoTimestampSchema.nullable(),
  generatedAt: IsoTimestampSchema,
  nodes: z.array(GraphNodeSchema).max(160),
  edges: z.array(GraphEdgeSchema).max(400),
  lanes: z.array(z.object({ id: GraphLaneSchema, label: z.string() })),
  /** Plain-language description of the whole graph for screen readers. */
  summary: z.string().max(2000),
  truncated: z.boolean(),
  nodeLimit: z.number().int(),
});
export type InvestigationGraph = z.infer<typeof InvestigationGraphSchema>;
