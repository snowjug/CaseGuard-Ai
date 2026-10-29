import { z } from 'zod';
import { IdSchema, IsoTimestampSchema } from './common';
import { CaseSummarySchema } from './case';
import { IngestOptionsSchema, IngestRequestSchema, IngestionPreviewSchema } from './bundle';
import { JobSchema } from './governance';
import { PermissionSchema, PersonaSchema } from './identity';
import { SkillLifecycleSchema } from './enums';
import {
  SkillApprovalSchema,
  SkillDnaSchema,
  SkillValidationSchema,
  SkillVersionSchema,
} from './skill';

export const PersonasResponseSchema = z.object({
  items: z.array(PersonaSchema),
  /** False when development identity is disabled (always the case in production). */
  enabled: z.boolean(),
  notice: z.string(),
});
export type PersonasResponse = z.infer<typeof PersonasResponseSchema>;

export const PreviewBodySchema = z.object({ source: IngestRequestSchema });
export type PreviewBody = z.infer<typeof PreviewBodySchema>;

export const CreateCaseBodySchema = z.object({
  source: IngestRequestSchema,
  options: IngestOptionsSchema.optional(),
});
export type CreateCaseBody = z.infer<typeof CreateCaseBodySchema>;

export const IngestResultSchema = z.object({
  case: CaseSummarySchema,
  sourceId: IdSchema,
  eventCount: z.number().int().min(0),
  /** False when an identical payload had already been ingested (idempotent replay). */
  created: z.boolean(),
  preview: IngestionPreviewSchema.pick({ redaction: true, injection: true, issues: true }),
  analysisJob: JobSchema.nullable(),
});
export type IngestResult = z.infer<typeof IngestResultSchema>;

export const StartAnalysisBodySchema = z.object({
  /** Re-run even when an analysis with identical input already exists. */
  force: z.boolean().default(false),
});
export type StartAnalysisBody = z.infer<typeof StartAnalysisBodySchema>;

export const StartAnalysisResponseSchema = z.object({
  job: JobSchema,
  runId: IdSchema.nullable(),
  /** True when an identical analysis already existed and was reused instead of re-run. */
  reused: z.boolean(),
});
export type StartAnalysisResponse = z.infer<typeof StartAnalysisResponseSchema>;

export const ExampleInfoSchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string(),
  fileName: z.string(),
  kind: z.enum(['case_bundle', 'transcript', 'csv']),
  sizeBytes: z.number().int().min(0),
  synthetic: z.literal(true),
  /** Present for transcript examples so the Paste tab can offer "insert example". */
  pasteText: z.string().max(200_000).optional(),
});
export type ExampleInfo = z.infer<typeof ExampleInfoSchema>;

export const ExportBodySchema = z.object({
  scope: z.enum(['case', 'audit']),
  caseId: IdSchema.optional(),
  reason: z.string().min(5).max(500),
});
export type ExportBody = z.infer<typeof ExportBodySchema>;

export const ExportResponseSchema = z.object({
  exportedAt: IsoTimestampSchema,
  scope: z.enum(['case', 'audit']),
  recordCount: z.number().int().min(0),
  notice: z.string(),
  data: z.record(z.string(), z.unknown()),
});
export type ExportResponse = z.infer<typeof ExportResponseSchema>;

export const SkillTransitionOptionSchema = z.object({
  toState: SkillLifecycleSchema,
  allowed: z.boolean(),
  /** Why the transition is unavailable (missing permission, gate not met, same approver...). */
  reason: z.string().nullable(),
  requiredPermission: PermissionSchema,
  requiresDistinctApprover: z.boolean(),
  /** Gate that must hold, e.g. "A passed simulation test exists for the current version". */
  gate: z.string().nullable(),
});
export type SkillTransitionOption = z.infer<typeof SkillTransitionOptionSchema>;

export const SkillDetailSchema = z.object({
  skill: SkillDnaSchema,
  currentVersion: SkillVersionSchema,
  proposedVersion: SkillVersionSchema.nullable(),
  versions: z.array(SkillVersionSchema.omit({ content: true })),
  validations: z.array(SkillValidationSchema),
  approvals: z.array(SkillApprovalSchema),
  matches: z.array(
    z.object({
      caseId: IdSchema,
      caseReference: z.string(),
      score: z.number(),
      applicability: z.enum(['applies', 'partial', 'not_applicable']),
      applied: z.boolean(),
    }),
  ),
  transitions: z.array(SkillTransitionOptionSchema),
  notices: z.array(z.string()),
});
export type SkillDetail = z.infer<typeof SkillDetailSchema>;
