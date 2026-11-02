import { z } from 'zod';
import { AsOfQuerySchema, IdSchema, IsoTimestampSchema, SourceFieldSchema } from './common';
import { EventTypeSchema, ParticipantRoleSchema } from './enums';
import { EvidenceLinkSchema } from './quality';

/** Most links one request may resolve. A screen of recommendations cites far fewer. */
export const PROVENANCE_MAX_LINKS = 40;

/**
 * How far an excerpt could be checked against the immutable stored text of its event.
 * - `verified`: the stored text holds exactly the cited window (whitespace folded), so the excerpt is a real quotation.
 * - `mismatch`: offsets were recorded but the stored text does not hold the excerpt there. It is never shown as a quotation.
 * - `not_checkable`: there is nothing to compare: a structured field, an inferred statement, or an analysis made before
 *   offsets were tied to a field. Nothing is claimed about the excerpt.
 */
export const ProvenanceVerificationSchema = z.enum(['verified', 'mismatch', 'not_checkable']);
export type ProvenanceVerification = z.infer<typeof ProvenanceVerificationSchema>;

export const ProvenanceSourceSchema = z.object({
  eventId: IdSchema,
  sourceId: IdSchema.nullable(),
  /** The stored text the offsets count into. Null when no offsets were recorded. */
  field: SourceFieldSchema.nullable(),
  start: z.number().int().min(0).nullable(),
  end: z.number().int().min(0).nullable(),
  /** The excerpt as the analysis recorded it. */
  excerpt: z.string().max(600).nullable(),
  verification: ProvenanceVerificationSchema,
  /** SHA-256 of the stored source payload the event came from, so a citation names its exact source. */
  contentHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  /**
   * Verbatim stored text around the cited window, cut to a bounded length. Null unless the excerpt was
   * `verified`: only a checked quotation is shown as one.
   */
  context: z
    .object({
      before: z.string().max(400),
      match: z.string().max(800),
      after: z.string().max(400),
    })
    .nullable(),
});
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export const ProvenanceItemSchema = z.object({
  link: EvidenceLinkSchema,
  /** What the link points at, in plain words. */
  title: z.string().max(300),
  /** When it became known (the event, the decision, the observation). Null for things without a time. */
  at: IsoTimestampSchema.nullable(),
  /** The source event behind it, when there is one. */
  event: z
    .object({
      id: IdSchema,
      title: z.string().max(300),
      type: EventTypeSchema,
      participantRole: ParticipantRoleSchema,
      timestamp: IsoTimestampSchema,
    })
    .nullable(),
  source: ProvenanceSourceSchema.nullable(),
});
export type ProvenanceItem = z.infer<typeof ProvenanceItemSchema>;

export const ProvenanceUnresolvedSchema = z.object({
  link: EvidenceLinkSchema,
  /** `not_found`: no such record in this case. `not_yet_known`: it exists but only after `asOf`. */
  reason: z.enum(['not_found', 'not_yet_known']),
});
export type ProvenanceUnresolved = z.infer<typeof ProvenanceUnresolvedSchema>;

export const ProvenanceQuerySchema = AsOfQuerySchema.extend({
  /** Comma-separated `type:id` pairs, for example `evidence:evd_ab12,fork:frk_cd34`. At most 40. */
  links: z.string().min(3).max(4000),
});
export type ProvenanceQuery = z.infer<typeof ProvenanceQuerySchema>;

export const ProvenanceResponseSchema = z.object({
  caseId: IdSchema,
  asOf: IsoTimestampSchema.nullable(),
  items: z.array(ProvenanceItemSchema).max(PROVENANCE_MAX_LINKS),
  /** Links that could not be resolved. They are reported, never dropped silently. */
  unresolved: z.array(ProvenanceUnresolvedSchema).max(PROVENANCE_MAX_LINKS),
});
export type ProvenanceResponse = z.infer<typeof ProvenanceResponseSchema>;
