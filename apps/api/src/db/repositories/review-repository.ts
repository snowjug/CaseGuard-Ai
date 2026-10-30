import {
  REVIEW_TARGETS,
  ReviewDecisionSchema,
  type Page,
  type ReviewDecision,
} from '@caseguard/schemas';
import { ValidationFailedError } from '../../errors';
import { decodeCursor, encodeCursor, normalizeLimit, toPage } from '../cursor';
import { REVIEW_DECISIONS } from './table-specs';
import {
  QueryBuilder,
  assertTenant,
  insertRows,
  parseStored,
  validateInput,
  type DataRow,
  type RepoContext,
} from './support';
import type { ReviewRepository, ReviewStats } from './types';

/** Decisions that mean "the reviewer accepted it" in the statistics. */
const ACCEPTING = ['approve', 'confirm'];

/** The only values a stored decision can have as its target type (they are validated on write). */
const TargetTypeSchema = ReviewDecisionSchema.shape.targetType;

interface StatsRow {
  reviewed_claims: number;
  corrected_claims: number;
  counterfactuals_reviewed: number;
  counterfactuals_accepted: number;
  counterfactuals_rejected: number;
}

export class ReviewRepositoryImpl implements ReviewRepository {
  constructor(private readonly ctx: RepoContext) {}

  async record(decision: ReviewDecision): Promise<void> {
    const valid = validateInput(ReviewDecisionSchema, decision, 'review decision');
    assertTenant(this.ctx, valid.tenantId);
    await this.ctx.run((tx) => insertRows(tx, REVIEW_DECISIONS, [valid]));
  }

  async list(query: {
    caseId?: string | undefined;
    targetType?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  }): Promise<Page<ReviewDecision>> {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor('reviews', query.cursor, ['timestamp', 'text']);
    // An unknown type can never match a stored decision, so it is a mistake worth a 422, not an empty page.
    let targetType: string | undefined;
    if (query.targetType !== undefined) {
      const parsed = TargetTypeSchema.safeParse(query.targetType);
      if (!parsed.success) {
        throw new ValidationFailedError('Invalid review target type', [
          { path: 'targetType', message: `Expected one of: ${REVIEW_TARGETS.join(', ')}` },
        ]);
      }
      targetType = parsed.data;
    }
    const q = new QueryBuilder();
    q.where(`tenant_id = ${q.bind(this.ctx.scope.tenantId)}`);
    if (query.caseId) q.where(`case_id = ${q.bind(query.caseId)}`);
    if (targetType !== undefined) q.where(`target_type = ${q.bind(targetType)}`);
    if (cursor) {
      q.where(`(decided_at, id) < (${q.bind(cursor[0])}::timestamptz, ${q.bind(cursor[1])}::text)`);
    }
    const limitParam = q.bind(limit + 1);
    const rows = await this.ctx.run(async (tx) => {
      const result = await tx.query<DataRow & { sort_ts: string; id: string }>(
        `SELECT data, decided_at AS sort_ts, id FROM review_decisions WHERE ${q.clause}
          ORDER BY decided_at DESC, id DESC LIMIT ${limitParam}::integer`,
        q.params,
      );
      return result.rows;
    });
    return toPage(
      rows,
      limit,
      (row) => parseStored(ReviewDecisionSchema, row.data, 'review decision'),
      (row) => encodeCursor('reviews', [row.sort_ts, row.id]),
    );
  }

  /**
   * Counts distinct reviewed targets by their latest decision, so a claim corrected twice counts once
   * and a counterfactual accepted and later rejected counts as rejected only.
   */
  async stats(): Promise<ReviewStats> {
    return this.ctx.run(async (tx) => {
      const result = await tx.query<StatsRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (target_type, target_id) target_type, decision
             FROM review_decisions
            WHERE tenant_id = $1 AND target_type IN ('claim', 'counterfactual')
            ORDER BY target_type, target_id, decided_at DESC, id DESC
         )
         SELECT
           (count(*) FILTER (WHERE target_type = 'claim'))::int AS reviewed_claims,
           (count(*) FILTER (WHERE target_type = 'claim' AND decision = 'correct'))::int AS corrected_claims,
           (count(*) FILTER (WHERE target_type = 'counterfactual'))::int AS counterfactuals_reviewed,
           (count(*) FILTER (WHERE target_type = 'counterfactual' AND decision = ANY($2::text[])))::int
             AS counterfactuals_accepted,
           (count(*) FILTER (WHERE target_type = 'counterfactual' AND decision = 'reject'))::int
             AS counterfactuals_rejected
           FROM latest`,
        [this.ctx.scope.tenantId, ACCEPTING],
      );
      const row = result.rows[0];
      return {
        reviewedClaims: row?.reviewed_claims ?? 0,
        correctedClaims: row?.corrected_claims ?? 0,
        counterfactualsReviewed: row?.counterfactuals_reviewed ?? 0,
        counterfactualsAccepted: row?.counterfactuals_accepted ?? 0,
        counterfactualsRejected: row?.counterfactuals_rejected ?? 0,
      };
    });
  }
}
