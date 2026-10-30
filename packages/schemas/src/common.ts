import { z } from 'zod';

/** Opaque identifier. Prefixed ULIDs for generated rows, human-readable slugs for seeded rows. */
export const IdSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'Identifiers may contain letters, digits, _ . : - only');
export type Id = z.infer<typeof IdSchema>;

/** All timestamps are UTC ISO-8601 with a trailing Z (assumption A-17). */
export const IsoTimestampSchema = z.iso.datetime({ message: 'Expected a UTC ISO-8601 timestamp' });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

/** Model estimate in [0, 1]. Never statistical truth. */
export const ProbabilitySchema = z.number().min(0).max(1);

export const ReviewStateSchema = z.enum(['pending', 'confirmed', 'corrected', 'rejected']);
export type ReviewState = z.infer<typeof ReviewStateSchema>;

/** Fields shared by tenant-owned, auditable records. */
export const RecordMetaSchema = z.object({
  tenantId: IdSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  createdBy: z.string().min(1).max(120),
  version: z.number().int().min(1),
});
export type RecordMeta = z.infer<typeof RecordMetaSchema>;

/** Pointer back to the immutable source text that supports a derived value. */
export const SourceRefSchema = z.object({
  eventId: IdSchema.optional(),
  sourceId: IdSchema.optional(),
  /** JSON pointer into the stored source payload, e.g. `/events/4/body`. */
  pointer: z.string().max(300).optional(),
  start: z.number().int().min(0).optional(),
  end: z.number().int().min(0).optional(),
  excerpt: z.string().max(600).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const ExtractionMethodSchema = z.enum([
  'structured',
  'rule',
  'pattern',
  'derived',
  'llm',
  'human',
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

/** Honesty labels attached to values that must never be mistaken for production data. */
export const ProvenanceLabelsSchema = z.object({
  synthetic: z.boolean(),
  estimated: z.boolean(),
  simulated: z.boolean(),
});
export type ProvenanceLabels = z.infer<typeof ProvenanceLabelsSchema>;

export const PageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export function pageOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    total: z.number().int().min(0).optional(),
  });
}
export type Page<T> = { items: T[]; nextCursor: string | null; total?: number | undefined };

/** RFC 9457-style problem details returned for every non-2xx response. */
export const ProblemSchema = z.object({
  type: z.string().max(200),
  title: z.string().max(200),
  status: z.number().int().min(400).max(599),
  detail: z.string().max(1000).optional(),
  code: z.string().max(80),
  /**
   * A stable, machine-readable refinement of `code` for conditions a client may handle on purpose (for
   * example `separation_of_duties`, `reference_in_use`, `job_active`). Never free text: clients may switch on it,
   * `detail` stays the only thing to show.
   */
  reason: z
    .string()
    .regex(/^[a-z][a-z0-9_]{2,39}$/)
    .optional(),
  correlationId: z.string().max(80).optional(),
  errors: z
    .array(z.object({ path: z.string().max(300), message: z.string().max(500) }))
    .max(100)
    .optional(),
});
export type Problem = z.infer<typeof ProblemSchema>;

export const EmptyObjectSchema = z.object({});

export const AsOfQuerySchema = z.object({
  /** Temporal boundary: only information available at or before this instant is returned. */
  asOf: IsoTimestampSchema.optional(),
});
export type AsOfQuery = z.infer<typeof AsOfQuerySchema>;
