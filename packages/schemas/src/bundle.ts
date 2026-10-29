import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common';
import {
  CaseStatusSchema,
  ChannelSchema,
  EffortLevelSchema,
  EventTypeSchema,
  ParticipantRoleSchema,
  SeveritySchema,
} from './enums';

/** Version tag carried by every case bundle. Bump on breaking changes and keep a migrator. */
export const CASE_BUNDLE_SCHEMA_VERSION = 'caseguard.case-bundle/1' as const;

export const StructuredValueSchema = z.union([
  z.string().max(500),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string().max(200), z.number(), z.boolean()])).max(50),
]);
export type StructuredValue = z.infer<typeof StructuredValueSchema>;
export const StructuredRecordSchema = z.record(z.string().min(1).max(64), StructuredValueSchema);
export type StructuredRecord = z.infer<typeof StructuredRecordSchema>;

/** AI-assist and compute usage attributed to one event in the original support process (synthetic). */
export const AiUsageSchema = z.object({
  model: z.string().max(80),
  promptTokens: z.number().int().min(0).max(5_000_000),
  completionTokens: z.number().int().min(0).max(5_000_000),
  cachedTokens: z.number().int().min(0).max(5_000_000).optional(),
  computeSeconds: z.number().min(0).max(100_000).optional(),
});
export type AiUsage = z.infer<typeof AiUsageSchema>;

export const BundleParticipantSchema = z.object({
  id: IdSchema,
  role: ParticipantRoleSchema,
  /** Synthetic alias, for example "Support Engineer 1". Never a real name. */
  alias: z.string().min(1).max(80),
});
export type BundleParticipant = z.infer<typeof BundleParticipantSchema>;

export const EventActionSchema = z.object({
  /** Knowledge-pack action id, e.g. `act.signin-log-correlation`. Omit when unmapped. */
  actionKey: z.string().max(80).optional(),
  label: z.string().min(1).max(200),
  customerEffort: EffortLevelSchema.default('none'),
  destructive: z.boolean().default(false),
  durationMinutes: z
    .number()
    .min(0)
    .max(60 * 24 * 14)
    .optional(),
  /** Author-declared repeat of an earlier action event. Analysis also detects repeats itself. */
  repeatOf: IdSchema.optional(),
});
export type EventAction = z.infer<typeof EventActionSchema>;

export const BundleEventSchema = z.object({
  id: IdSchema,
  timestamp: IsoTimestampSchema,
  participantId: IdSchema,
  type: EventTypeSchema,
  channel: ChannelSchema.optional(),
  title: z.string().max(200).optional(),
  body: z.string().max(20_000),
  action: EventActionSchema.optional(),
  /** Event this one answers (customer reply, tool output). Drives latency and attribution. */
  inResponseTo: IdSchema.optional(),
  correlationIds: z.array(z.string().min(1).max(80)).max(20).default([]),
  /** Optional machine-readable annotations produced by tooling (e.g. query row counts). */
  structured: StructuredRecordSchema.optional(),
  ai: AiUsageSchema.optional(),
});
export type BundleEvent = z.infer<typeof BundleEventSchema>;

export const BundleResolutionSchema = z.object({
  resolvedAt: IsoTimestampSchema,
  summary: z.string().min(1).max(4000),
  rootCause: z.string().min(1).max(4000),
  workaround: z.string().max(4000).optional(),
  permanentFix: z.string().max(4000).optional(),
  /**
   * Knowledge-pack hypothesis id matching the root cause. Used ONLY by the hindsight check and the
   * evaluation harness; it is never available to any analysis that runs before `resolvedAt`.
   */
  rootCauseHypothesisKey: z.string().max(80).optional(),
  validation: z
    .object({
      validatedAt: IsoTimestampSchema,
      method: z.string().min(1).max(1000),
      outcome: z.enum(['confirmed', 'partial', 'failed']),
      evidenceEventIds: z.array(IdSchema).max(20).default([]),
    })
    .optional(),
});
export type BundleResolution = z.infer<typeof BundleResolutionSchema>;

export const BundleCaseSchema = z.object({
  reference: z
    .string()
    .regex(/^[A-Z0-9][A-Z0-9-]{3,39}$/, 'Use upper-case letters, digits and dashes (4-40 chars)'),
  title: z.string().min(5).max(200),
  product: z.string().min(1).max(100),
  /** Knowledge-pack workload key, e.g. `teams-authentication`. */
  workload: z.string().min(1).max(80),
  severity: SeveritySchema,
  status: CaseStatusSchema,
  openedAt: IsoTimestampSchema,
  closedAt: IsoTimestampSchema.optional(),
  customerAlias: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});

export const CaseBundleSchema = z
  .object({
    schemaVersion: z.literal(CASE_BUNDLE_SCHEMA_VERSION),
    synthetic: z.boolean(),
    syntheticNotice: z.string().max(500).optional(),
    case: BundleCaseSchema,
    participants: z.array(BundleParticipantSchema).min(1).max(30),
    events: z.array(BundleEventSchema).min(1).max(2000),
    resolution: BundleResolutionSchema.optional(),
  })
  .superRefine((bundle, ctx) => {
    const participantIds = new Set<string>();
    bundle.participants.forEach((p, i) => {
      if (participantIds.has(p.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate participant id "${p.id}"`,
          path: ['participants', i, 'id'],
        });
      }
      participantIds.add(p.id);
    });
    const eventIds = new Set<string>();
    bundle.events.forEach((e, i) => {
      if (eventIds.has(e.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate event id "${e.id}"`,
          path: ['events', i, 'id'],
        });
      }
      eventIds.add(e.id);
      if (!participantIds.has(e.participantId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Unknown participant "${e.participantId}"`,
          path: ['events', i, 'participantId'],
        });
      }
    });
    bundle.events.forEach((e, i) => {
      if (e.inResponseTo && !eventIds.has(e.inResponseTo)) {
        ctx.addIssue({
          code: 'custom',
          message: `inResponseTo references unknown event "${e.inResponseTo}"`,
          path: ['events', i, 'inResponseTo'],
        });
      }
      if (e.action?.repeatOf && !eventIds.has(e.action.repeatOf)) {
        ctx.addIssue({
          code: 'custom',
          message: `repeatOf references unknown event "${e.action.repeatOf}"`,
          path: ['events', i, 'action', 'repeatOf'],
        });
      }
    });
    // A reply or declared repeat can only point at something recorded earlier, in the order the
    // platform assigns on ingestion (timestamp, then position in the file). A forward reference would
    // let a later event change how an earlier one is read.
    const ingestionOrder = bundle.events
      .map((e, i) => ({ id: e.id, ms: Date.parse(e.timestamp), i }))
      .sort((a, b) => a.ms - b.ms || a.i - b.i);
    const orderOf = new Map(ingestionOrder.map((o, position) => [o.id, position]));
    bundle.events.forEach((e, i) => {
      const own = orderOf.get(e.id);
      const refs = [
        { ref: e.inResponseTo, field: 'inResponseTo', path: ['events', i, 'inResponseTo'] },
        { ref: e.action?.repeatOf, field: 'repeatOf', path: ['events', i, 'action', 'repeatOf'] },
      ];
      for (const { ref, field, path } of refs) {
        const target = ref ? orderOf.get(ref) : undefined;
        if (own !== undefined && target !== undefined && target >= own) {
          ctx.addIssue({
            code: 'custom',
            message: `${field} must point at an earlier event, but "${ref}" is not earlier than "${e.id}"`,
            path,
          });
        }
      }
    });
    const first = bundle.events.reduce(
      (min, e) => (e.timestamp < min ? e.timestamp : min),
      bundle.events[0]?.timestamp ?? bundle.case.openedAt,
    );
    if (first < bundle.case.openedAt) {
      ctx.addIssue({
        code: 'custom',
        message: 'An event is earlier than case.openedAt',
        path: ['case', 'openedAt'],
      });
    }
    if (bundle.resolution) {
      const resolutionEventIds = bundle.resolution.validation?.evidenceEventIds ?? [];
      resolutionEventIds.forEach((id, i) => {
        if (!eventIds.has(id)) {
          ctx.addIssue({
            code: 'custom',
            message: `Validation evidence references unknown event "${id}"`,
            path: ['resolution', 'validation', 'evidenceEventIds', i],
          });
        }
      });
    }
  });
export type CaseBundle = z.infer<typeof CaseBundleSchema>;

// ---------------------------------------------------------------- ingestion

export const SourceKindSchema = z.enum([
  'builtin_sample',
  'pasted_text',
  'uploaded_file',
  'json_bundle',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const REDACTION_CATEGORIES = [
  'bearer_token',
  'api_key',
  'connection_string',
  'private_key',
  'password_assignment',
  'jwt',
  'github_token',
  'azure_storage_key',
  'email_address',
  'ipv4_address',
  'phone_number',
  'custom',
] as const;
export const RedactionCategorySchema = z.enum(REDACTION_CATEGORIES);
export type RedactionCategory = z.infer<typeof RedactionCategorySchema>;

export const RedactionFindingSchema = z.object({
  category: RedactionCategorySchema,
  count: z.number().int().min(1),
  /** Stable placeholder written into the stored text, e.g. `[REDACTED:bearer_token]`. */
  placeholder: z.string().max(60),
});
export type RedactionFinding = z.infer<typeof RedactionFindingSchema>;

export const RedactionSummarySchema = z.object({
  applied: z.boolean(),
  totalReplacements: z.number().int().min(0),
  findings: z.array(RedactionFindingSchema),
});
export type RedactionSummary = z.infer<typeof RedactionSummarySchema>;

export const InjectionFindingSchema = z.object({
  ruleId: z.string().max(60),
  severity: z.enum(['low', 'medium', 'high']),
  eventId: IdSchema.nullable(),
  /** Short excerpt of the offending text (already redacted). */
  excerpt: z.string().max(240),
  explanation: z.string().max(300),
});
export type InjectionFinding = z.infer<typeof InjectionFindingSchema>;

export const InjectionSummarySchema = z.object({
  detected: z.boolean(),
  highestSeverity: z.enum(['none', 'low', 'medium', 'high']),
  findings: z.array(InjectionFindingSchema).max(100),
});
export type InjectionSummary = z.infer<typeof InjectionSummarySchema>;

export const ValidationIssueSchema = z.object({
  path: z.string().max(300),
  message: z.string().max(500),
  severity: z.enum(['error', 'warning']),
});
export type ValidationIssue = z.infer<typeof ValidationIssueSchema>;

export const PreviewEventSchema = z.object({
  id: IdSchema,
  timestamp: IsoTimestampSchema,
  type: EventTypeSchema,
  participantRole: ParticipantRoleSchema,
  title: z.string().nullable(),
  bodyExcerpt: z.string().max(400),
});
export type PreviewEvent = z.infer<typeof PreviewEventSchema>;

export const IngestionSummarySchema = z.object({
  reference: z.string(),
  title: z.string(),
  product: z.string(),
  workload: z.string(),
  eventCount: z.number().int().min(0),
  participantCount: z.number().int().min(0),
  firstEventAt: IsoTimestampSchema.nullable(),
  lastEventAt: IsoTimestampSchema.nullable(),
  hasResolution: z.boolean(),
  durationHours: z.number().min(0),
});
export type IngestionSummary = z.infer<typeof IngestionSummarySchema>;

export const IngestRequestSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('sample'), sampleId: IdSchema }),
  z.object({
    type: z.literal('paste'),
    text: z.string().min(1).max(200_000),
    title: z.string().min(5).max(200).optional(),
    workload: z.string().max(80).optional(),
  }),
  /** Raw JSON bundle; validated with CaseBundleSchema so errors can be reported per field. */
  z.object({ type: z.literal('bundle'), bundle: z.unknown() }),
]);
export type IngestRequest = z.infer<typeof IngestRequestSchema>;

export const IngestionPreviewSchema = z.object({
  ok: z.boolean(),
  sourceKind: SourceKindSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().min(0),
  synthetic: z.boolean(),
  issues: z.array(ValidationIssueSchema).max(200),
  redaction: RedactionSummarySchema,
  injection: InjectionSummarySchema,
  summary: IngestionSummarySchema.nullable(),
  eventsPreview: z.array(PreviewEventSchema).max(25),
  /** Set when an identical payload was already ingested for this tenant (idempotency hint). */
  alreadyIngestedCaseId: IdSchema.nullable(),
});
export type IngestionPreview = z.infer<typeof IngestionPreviewSchema>;

export const IngestOptionsSchema = z.object({
  analyze: z.boolean().default(true),
});

export const SampleBundleInfoSchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string(),
  reference: z.string(),
  workload: z.string(),
  eventCount: z.number().int(),
  synthetic: z.literal(true),
  role: z.enum(['primary', 'followup']),
});
export type SampleBundleInfo = z.infer<typeof SampleBundleInfoSchema>;
