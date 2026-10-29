import { z } from 'zod';
import {
  ExtractionMethodSchema,
  IdSchema,
  IsoTimestampSchema,
  ProbabilitySchema,
  RecordMetaSchema,
  ReviewStateSchema,
  SourceRefSchema,
} from './common';
import {
  AiUsageSchema,
  EventActionSchema,
  RedactionCategorySchema,
  SourceKindSchema,
  StructuredRecordSchema,
} from './bundle';
import {
  CaseStatusSchema,
  ChannelSchema,
  EventTypeSchema,
  ParticipantRoleSchema,
  SeveritySchema,
} from './enums';

export const AnalysisStateSchema = z.enum([
  'not_analyzed',
  'queued',
  'running',
  'analyzed',
  'failed',
]);
export type AnalysisState = z.infer<typeof AnalysisStateSchema>;

export const CaseSchema = RecordMetaSchema.extend({
  id: IdSchema,
  reference: z.string(),
  title: z.string(),
  product: z.string(),
  workload: z.string(),
  severity: SeveritySchema,
  status: CaseStatusSchema,
  customerAlias: z.string(),
  openedAt: IsoTimestampSchema,
  closedAt: IsoTimestampSchema.nullable(),
  synthetic: z.boolean(),
  tags: z.array(z.string()),
  eventCount: z.number().int().min(0),
  firstEventAt: IsoTimestampSchema.nullable(),
  lastEventAt: IsoTimestampSchema.nullable(),
  sourceId: IdSchema,
  sourceKind: SourceKindSchema,
  contentHash: z.string(),
  redactionApplied: z.boolean(),
  redactionReplacements: z.number().int().min(0),
  injectionDetected: z.boolean(),
  hasResolution: z.boolean(),
  analysisState: AnalysisStateSchema,
  lastAnalysisRunId: IdSchema.nullable(),
  analyzedAt: IsoTimestampSchema.nullable(),
  /** Free-form, role-gated notes are intentionally absent: the case is an immutable record. */
});
export type Case = z.infer<typeof CaseSchema>;

/** Light projection used in lists and the command center. */
export const CaseSummarySchema = CaseSchema.pick({
  id: true,
  reference: true,
  title: true,
  product: true,
  workload: true,
  severity: true,
  status: true,
  customerAlias: true,
  openedAt: true,
  closedAt: true,
  synthetic: true,
  eventCount: true,
  analysisState: true,
  analyzedAt: true,
  hasResolution: true,
  injectionDetected: true,
}).extend({
  qualityIndex: z.number().min(0).max(100).nullable(),
  avoidableEffortPct: z.number().min(0).max(100).nullable(),
  leadingHypothesis: z.object({ name: z.string(), confidence: ProbabilitySchema }).nullable(),
  openWarningCount: z.number().int().min(0),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

/** Immutable record of exactly what was received (after mandatory redaction). */
export const CaseSourceSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  kind: SourceKindSchema,
  fileName: z.string().nullable(),
  mediaType: z.string(),
  sizeBytes: z.number().int().min(0),
  /** SHA-256 of the payload as received, before redaction (integrity attestation). */
  receivedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** SHA-256 of the stored, redacted payload. */
  storedSha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageRef: z.string(),
  redactionApplied: z.boolean(),
  redactionReplacements: z.number().int().min(0),
  synthetic: z.boolean(),
  immutable: z.literal(true),
});
export type CaseSource = z.infer<typeof CaseSourceSchema>;

export const CaseParticipantSchema = z.object({
  id: IdSchema,
  role: ParticipantRoleSchema,
  alias: z.string(),
  eventCount: z.number().int().min(0),
  firstSeenAt: IsoTimestampSchema.nullable(),
});
export type CaseParticipant = z.infer<typeof CaseParticipantSchema>;

export const CaseEventSchema = RecordMetaSchema.extend({
  id: IdSchema,
  caseId: IdSchema,
  sourceId: IdSchema,
  /** Zero-based position after sorting by (timestamp, source order). Stable and gap-free. */
  sequence: z.number().int().min(0),
  timestamp: IsoTimestampSchema,
  participantId: IdSchema,
  participantRole: ParticipantRoleSchema,
  participantAlias: z.string(),
  type: EventTypeSchema,
  channel: ChannelSchema.nullable(),
  title: z.string().nullable(),
  /** Redacted body text. Always rendered as plain text by the UI. */
  body: z.string(),
  action: EventActionSchema.nullable(),
  inResponseTo: IdSchema.nullable(),
  correlationIds: z.array(z.string()),
  structured: StructuredRecordSchema.nullable(),
  ai: AiUsageSchema.nullable(),
  /** JSON pointer into the stored source payload, e.g. `/events/4`. */
  sourcePointer: z.string(),
  redaction: z.object({ redacted: z.boolean(), categories: z.array(RedactionCategorySchema) }),
  immutable: z.literal(true),
});
export type CaseEvent = z.infer<typeof CaseEventSchema>;

export const CaseResolutionSchema = z.object({
  caseId: IdSchema,
  resolvedAt: IsoTimestampSchema,
  summary: z.string(),
  rootCause: z.string(),
  workaround: z.string().nullable(),
  permanentFix: z.string().nullable(),
  rootCauseHypothesisKey: z.string().nullable(),
  validation: z
    .object({
      validatedAt: IsoTimestampSchema,
      method: z.string(),
      outcome: z.enum(['confirmed', 'partial', 'failed']),
      evidenceEventIds: z.array(IdSchema),
    })
    .nullable(),
});
export type CaseResolution = z.infer<typeof CaseResolutionSchema>;

// ---------------------------------------------------------------- digital twin

export const TWIN_SECTIONS = [
  'problem_statement',
  'customer_impact',
  'environment',
  'scope',
  'participants',
  'observations',
  'actions',
  'decisions',
  'communications',
  'escalations',
  'resolution',
  'validation',
  'remaining_risks',
  'unknowns',
] as const;
export const TwinSectionSchema = z.enum(TWIN_SECTIONS);
export type TwinSection = z.infer<typeof TwinSectionSchema>;
export const TWIN_SECTION_LABELS: Record<TwinSection, string> = {
  problem_statement: 'Problem statement',
  customer_impact: 'Customer impact',
  environment: 'Environment',
  scope: 'Scope',
  participants: 'Participants',
  observations: 'Observations',
  actions: 'Actions',
  decisions: 'Decisions',
  communications: 'Communications',
  escalations: 'Escalations',
  resolution: 'Resolution',
  validation: 'Validation',
  remaining_risks: 'Remaining risks',
  unknowns: 'Unknowns',
};

/** One extracted value with full provenance: value, source, confidence, method, time, review. */
export const TwinFieldSchema = z.object({
  id: IdSchema,
  section: TwinSectionSchema,
  label: z.string().max(160),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
  display: z.string().max(1000),
  sourceRefs: z.array(SourceRefSchema).max(12),
  confidence: ProbabilitySchema,
  method: ExtractionMethodSchema,
  extractedAt: IsoTimestampSchema,
  reviewStatus: ReviewStateSchema,
  /** Instant at which the information became known (drives as-of filtering). */
  observedAt: IsoTimestampSchema.nullable(),
});
export type TwinField = z.infer<typeof TwinFieldSchema>;

export const DigitalTwinSchema = z.object({
  caseId: IdSchema,
  analysisRunId: IdSchema,
  asOf: IsoTimestampSchema.nullable(),
  generatedAt: IsoTimestampSchema,
  fields: z.array(TwinFieldSchema),
  sectionCounts: z.record(z.string(), z.number().int().min(0)),
  participants: z.array(CaseParticipantSchema),
  /** Later events withheld by the temporal boundary (count only; never their content). */
  withheldFutureEventCount: z.number().int().min(0),
});
export type DigitalTwin = z.infer<typeof DigitalTwinSchema>;
