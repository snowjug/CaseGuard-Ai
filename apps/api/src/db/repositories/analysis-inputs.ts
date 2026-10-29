import { EvidenceCategorySchema, IsoTimestampSchema, ReviewStateSchema } from '@caseguard/schemas';
import { z } from 'zod';
import { ConflictError } from '../../errors';

/** Validation of the reviewer inputs accepted by the analysis repository. */

export const ReviewClaimSchema = z.object({
  reviewedCategory: EvidenceCategorySchema,
  reason: z.string().trim().min(1).max(1000),
  reviewedBy: z.string().min(1).max(120),
  reviewedAt: IsoTimestampSchema,
  expectedVersion: z.number().int().min(1),
});

export const ForkReviewSchema = z.object({
  reviewState: ReviewStateSchema,
  reason: z.string().max(1000).nullable(),
  expectedVersion: z.number().int().min(1),
});

export const DismissSchema = z.object({
  by: z.string().min(1).max(120),
  at: IsoTimestampSchema,
  reason: z.string(),
  expectedVersion: z.number().int().min(1),
});

export function ensureUpdated(changed: number, what: string): void {
  // The row is locked FOR UPDATE before it is rewritten, so this only fires on a logic error.
  if (changed !== 1) throw new ConflictError(`${what} was modified concurrently; reload and retry`);
}
